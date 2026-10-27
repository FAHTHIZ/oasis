import { spawn } from 'node:child_process';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfigDirectory } from './config.mjs';
import { createSession, runAgentTurn, closeSession } from './agent.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TASKS_DIR = path.join(APP_ROOT, 'evals', 'tasks');
const OUTPUT_LIMIT = 12000;
const DEFAULT_TIMEOUT_MS = 120000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.venv', 'venv', 'vendor', 'target', '.oasis', 'eval-results', '.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker']);

function safeId(value) {
  return typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
}

function isSensitiveName(name) {
  const lower = name.toLowerCase();
  return lower === '.env' || lower.startsWith('.env.') ||
    ['id_rsa', 'id_ed25519', 'credentials', 'secrets.json', 'token.json', '.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker'].includes(lower) ||
    /\.(pem|key|p12|pfx)$/i.test(lower);
}

function scrubEnvironment(env = process.env) {
  const safe = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AUTHORIZATION|GITHUB_TOKEN|GH_TOKEN)/i.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

function capture(output, chunk) {
  return (output + chunk.toString('utf8')).slice(-OUTPUT_LIMIT);
}

function runProcess(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || scrubEnvironment();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr, output: (stdout + (stderr ? '\n' + stderr : '')).slice(-OUTPUT_LIMIT) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch {}
      const killTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 1000);
      killTimer.unref?.();
    }, timeoutMs);
    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true });
      child.stdout.on('data', (chunk) => { stdout = capture(stdout, chunk); });
      child.stderr.on('data', (chunk) => { stderr = capture(stderr, chunk); });
      child.on('error', (error) => finish({ exitCode: 127, signal: null, error: error.message, timedOut }));
      child.on('close', (code, signal) => finish({ exitCode: timedOut ? 124 : (code ?? 1), signal, timedOut }));
    } catch (error) {
      finish({ exitCode: 127, signal: null, error: error.message, timedOut });
    }
  });
}

async function assertTaskShape(taskDir) {
  const id = path.basename(taskDir);
  if (!safeId(id)) throw new Error('Invalid evaluation task ID: ' + id);
  const repoDir = path.join(taskDir, 'repo');
  const taskPath = path.join(taskDir, 'task.md');
  const patchPath = path.join(taskDir, 'reference.patch');
  const verifierMjs = path.join(taskDir, 'verify.mjs');
  const verifierSh = path.join(taskDir, 'verify.sh');
  const info = await lstat(repoDir).catch(() => null);
  if (!info || !info.isDirectory() || info.isSymbolicLink()) throw new Error(id + ': missing repo/ directory');
  const taskInfo = await lstat(taskPath).catch(() => null);
  if (!taskInfo || !taskInfo.isFile() || taskInfo.isSymbolicLink()) throw new Error(id + ': task.md must be a regular file');
  if (taskInfo.size > 30000) throw new Error(id + ': task.md is larger than 30 KB');
  const taskText = await readFile(taskPath, 'utf8');
  if (!taskText.trim()) throw new Error(id + ': task.md is missing or empty');
  const patchInfo = await lstat(patchPath).catch(() => null);
  if (!patchInfo || !patchInfo.isFile() || patchInfo.isSymbolicLink()) throw new Error(id + ': reference.patch must be a regular file');
  if (patchInfo.size > 2 * 1024 * 1024) throw new Error(id + ': reference.patch is larger than 2 MiB');
  const patch = await readFile(patchPath, 'utf8');
  if (!patch.trim()) throw new Error(id + ': reference.patch is missing or empty');
  let verifierPath = null;
  for (const candidate of [verifierMjs, verifierSh]) {
    const stat = await lstat(candidate).catch(() => null);
    if (stat && stat.isFile() && !stat.isSymbolicLink()) { verifierPath = candidate; break; }
  }
  if (!verifierPath) throw new Error(id + ': add verify.mjs or verify.sh');
  const patchPathMatches = patch.split(/\r?\n/).filter((line) => /^(---|\+\+\+) /.test(line));
  for (const line of patchPathMatches) {
    const match = line.match(/^(?:---|\+\+\+) [ab]\/(.+?)(?:\t.*)?$/);
    if (!match) continue;
    const target = match[1];
    const normalized = target.replace(/\\/g, '/');
    if (target === '/dev/null' || path.posix.isAbsolute(normalized) || /^[a-z]:/i.test(normalized) ||
        normalized.split('/').some((part) => part === '..' || part === '.' || isSensitiveName(part))) {
      throw new Error(id + ': reference.patch contains an unsafe or sensitive file path');
    }
  }
  return { id, taskDir, repoDir, taskPath, taskText, patchPath, verifierPath };
}

async function listTaskDirectories(tasksDir = DEFAULT_TASKS_DIR) {
  const entries = await readdir(tasksDir, { withFileTypes: true }).catch((error) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  return entries
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink() && safeId(entry.name))
    .map((entry) => path.join(tasksDir, entry.name))
    .sort();
}

async function copySnapshot(source, destination) {
  const rootInfo = await lstat(source);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Task repository snapshot must be a regular directory.');
  await mkdir(destination, { recursive: true });
  async function walk(from, to, relative = '') {
    const entries = await readdir(from, { withFileTypes: true });
    for (const entry of entries) {
      const rel = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Refusing to evaluate a snapshot containing a symbolic link: ' + rel);
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (isSensitiveName(entry.name)) continue;
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (entry.isDirectory()) {
        await mkdir(dst, { recursive: true });
        await walk(src, dst, rel);
      } else if (entry.isFile()) {
        await copyFile(src, dst);
      }
    }
  }
  await walk(source, destination);
}

async function runVerifier(task, workspace, env, timeoutMs = 60000) {
  const command = task.verifierPath.endsWith('.mjs') ? process.execPath :
    (process.platform === 'win32' ? null : '/bin/sh');
  if (!command) return { exitCode: 127, output: 'verify.sh is unsupported on Windows; use verify.mjs for cross-platform tasks.' };
  const args = task.verifierPath.endsWith('.mjs')
    ? [task.verifierPath, workspace, task.taskDir]
    : [task.verifierPath, workspace, task.taskDir];
  const result = await runProcess(command, args, {
    cwd: workspace,
    env: scrubEnvironment(env),
    timeoutMs
  });
  return { exitCode: result.exitCode, output: result.output, timedOut: result.timedOut, error: result.error || null };
}

async function applyReferencePatch(task, workspace, env) {
  // The disposable copy intentionally excludes the source repository's .git directory.
  // Initialize a throwaway repo so git apply has consistent work-tree semantics.
  const initialized = await runProcess('git', ['init', '--quiet'], {
    cwd: workspace, env: scrubEnvironment(env), timeoutMs: 20000
  });
  if (initialized.exitCode !== 0) return { ...initialized, stage: 'git-init' };
  const check = await runProcess('git', ['apply', '--check', '--whitespace=error', task.patchPath], {
    cwd: workspace, env: scrubEnvironment(env), timeoutMs: 20000
  });
  if (check.exitCode !== 0) return { ...check, stage: 'check' };
  const apply = await runProcess('git', ['apply', '--whitespace=error', task.patchPath], {
    cwd: workspace, env: scrubEnvironment(env), timeoutMs: 20000
  });
  return { ...apply, stage: 'apply' };
}

/**
 * Validate every task in the suite without calling a model.
 * A valid task's reference patch must pass its verifier, while the untouched
 * baseline must fail it. Verification code and patches stay outside repo/ until used.
 */
export async function validateEvaluationSuite(options = {}) {
  const tasksDir = options.tasksDir || DEFAULT_TASKS_DIR;
  const env = options.env || process.env;
  const dirs = await listTaskDirectories(tasksDir);
  const results = [];
  if (!dirs.length) return { ok: false, total: 0, results, error: 'No evaluation tasks were found in ' + tasksDir };

  for (const dir of dirs) {
    let task;
    let tempRoot;
    try {
      task = await assertTaskShape(dir);
      tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oasis-eval-validate-'));
      const noOpRoot = path.join(tempRoot, 'no-op');
      await copySnapshot(task.repoDir, noOpRoot);
      const noOp = await runVerifier(task, noOpRoot, env);
      if (noOp.exitCode === 0) {
        throw new Error('No-op check failed: verify script passes before the reference patch is applied.');
      }
      const referenceRoot = path.join(tempRoot, 'reference');
      await copySnapshot(task.repoDir, referenceRoot);
      const patch = await applyReferencePatch(task, referenceRoot, env);
      if (patch.exitCode !== 0) {
        throw new Error('Reference patch could not be applied (' + patch.stage + '): ' + (patch.output || patch.error || 'unknown git error'));
      }
      const reference = await runVerifier(task, referenceRoot, env);
      if (reference.exitCode !== 0) {
        throw new Error('Reference patch failed its verifier: ' + (reference.output || 'exit code ' + reference.exitCode));
      }
      results.push({ id: task.id, ok: true, noOpExitCode: noOp.exitCode, referenceExitCode: reference.exitCode });
    } catch (error) {
      results.push({ id: path.basename(dir), ok: false, error: error.message || String(error) });
    } finally {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { ok: results.length > 0 && results.every((result) => result.ok), total: results.length, results };
}

function parseArgs(args) {
  const config = { validate: false, task: null, trials: 3, help: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--validate') { config.validate = true; continue; }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--task') {
      if (!args[i + 1]) throw new Error('--task requires an evaluation task ID.');
      config.task = args[++i];
      continue;
    }
    if (arg === '--trials') {
      const value = Number.parseInt(args[++i], 10);
      if (!Number.isInteger(value) || value < 1 || value > 10) throw new Error('--trials must be an integer from 1 to 10.');
      config.trials = value;
      continue;
    }
    throw new Error('Unknown oasis eval option: ' + arg);
  }
  if (config.task && !safeId(config.task)) throw new Error('Task IDs may contain lowercase letters, numbers, and hyphens.');
  if (config.validate && (config.task || config.trials !== 3)) throw new Error('--validate runs the complete suite; do not combine it with --task or --trials.');
  return config;
}

function readPrice(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function costEstimate(inputTokens, outputTokens, inputRate, outputRate) {
  if (inputRate === null || outputRate === null) return null;
  return Math.round(((inputTokens * inputRate + outputTokens * outputRate) / 1000000) * 1000000) / 1000000;
}

async function saveResults(results, metadata, options = {}) {
  const env = options.env || process.env;
  const outputDir = options.resultsDir || env.OASIS_EVAL_RESULTS_DIR || path.join(getConfigDirectory(env), 'eval-results');
  await mkdir(outputDir, { recursive: true, mode: 0o700 });
  const pathName = path.join(outputDir, 'run-' + new Date().toISOString().replace(/[:.]/g, '-') + '-' + process.pid + '.json');
  const payload = { ...metadata, results };
  await writeFile(pathName, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { await chmod(pathName, 0o600); } catch {}
  return pathName;
}

function printValidation(report, output = process.stdout) {
  output.write('Oasis eval suite validation\n');
  for (const result of report.results) {
    output.write((result.ok ? '  PASS ' : '  FAIL ') + result.id + (result.error ? ': ' + result.error : '') + '\n');
  }
  output.write('Validated ' + report.results.length + ' task(s): ' + report.results.filter((item) => item.ok).length + ' passed, ' + report.results.filter((item) => !item.ok).length + ' failed.\n');
  if (report.error) output.write(report.error + '\n');
}

export async function runEvalCommand(args = [], options = {}) {
  const output = options.output || process.stdout;
  const env = options.env || process.env;
  const tasksDir = options.tasksDir || DEFAULT_TASKS_DIR;
  const config = parseArgs(args);
  if (config.help) {
    output.write('Usage:\n  oasis eval --validate\n  oasis eval [--task ID] [--trials N] --yes\n\n');
    output.write('Evaluation execution runs model-generated code in disposable copies. It is not OS-sandboxed. Review the task suite and only run with --yes in a controlled workspace.\n');
    return { ok: true };
  }
  if (config.validate) {
    const report = await validateEvaluationSuite({ tasksDir, env });
    printValidation(report, output);
    return { ok: report.ok, report };
  }

  if (!options.autoApprove) throw new Error('Model evaluation executes edits and commands in disposable task copies. Review the evaluation suite, then explicitly run oasis eval --yes [--task ID] [--trials N]. OS-level sandboxing is not provided.');
  const allDirs = await listTaskDirectories(tasksDir);
  const selectedDirs = config.task ? allDirs.filter((dir) => path.basename(dir) === config.task) : allDirs;
  if (!selectedDirs.length) throw new Error(config.task ? 'No evaluation task named "' + config.task + '" was found.' : 'No evaluation tasks were found in ' + tasksDir);
  const provider = await loadConfig({ env });
  if (!provider.configured) throw new Error('Configure a model provider before running eval tasks.');
  const startedAt = new Date().toISOString();
  const inputRate = readPrice(env.OASIS_EVAL_INPUT_USD_PER_MILLION_TOKENS);
  const outputRate = readPrice(env.OASIS_EVAL_OUTPUT_USD_PER_MILLION_TOKENS);
  const trials = [];
  const originalConfigDir = process.env.OASIS_CONFIG_DIR;

  try {
    for (const dir of selectedDirs) {
      const task = await assertTaskShape(dir);
      for (let trial = 1; trial <= config.trials; trial++) {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oasis-eval-run-'));
        const workspace = path.join(tempRoot, 'workspace');
        await copySnapshot(task.repoDir, workspace);
        const isolatedConfigDir = path.join(tempRoot, 'oasis-config');
        await mkdir(isolatedConfigDir, { recursive: true, mode: 0o700 });
        let session = null;
        let usage = { inputTokens: 0, outputTokens: 0 };
        let agentResult = null;
        let errorText = null;
        let verification = { exitCode: 1, output: 'Agent did not complete.' };
        const trialStarted = Date.now();

        try {
          process.env.OASIS_CONFIG_DIR = isolatedConfigDir;
          session = await createSession({ root: workspace, config: provider });
          agentResult = await runAgentTurn(session, task.taskText, {
            autoApprove: true,
            env: process.env,
            maxSteps: provider.maxSteps,
            onUsage: (entry) => {
              usage.inputTokens += Number(entry.inputTokens || 0);
              usage.outputTokens += Number(entry.outputTokens || 0);
            }
          });
        } catch (error) {
          errorText = error.message || String(error);
        } finally {
          if (session) closeSession(session);
          if (originalConfigDir === undefined) delete process.env.OASIS_CONFIG_DIR;
          else process.env.OASIS_CONFIG_DIR = originalConfigDir;
        }

        if (!errorText && agentResult) verification = await runVerifier(task, workspace, env);
        const elapsedMs = Date.now() - trialStarted;
        const totalTokens = usage.inputTokens + usage.outputTokens;
        const costUSD = costEstimate(usage.inputTokens, usage.outputTokens, inputRate, outputRate);
        const passed = !errorText && Boolean(agentResult && agentResult.finished) && verification.exitCode === 0;
        trials.push({
          taskId: task.id, trial,
          status: passed ? 'passed' : 'failed',
          model: provider.model, protocol: provider.protocol, baseURL: provider.baseURL,
          maxSteps: provider.maxSteps, maxOutputTokens: provider.maxOutputTokens,
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens,
          costUSD, wallTimeMs: elapsedMs, finished: Boolean(agentResult && agentResult.finished),
          toolCalls: agentResult ? agentResult.toolCalls : 0,
          verification: { exitCode: verification.exitCode, output: verification.output },
          error: errorText
        });
        output.write((passed ? '  PASS ' : '  FAIL ') + task.id + ' trial ' + trial +
          ' · ' + totalTokens + ' tokens · ' + elapsedMs + ' ms' +
          (costUSD === null ? ' · cost n/a (set OASIS_EVAL_*_USD_PER_MILLION_TOKENS)' : ' · $' + costUSD.toFixed(6)) + '\n');
        await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
      }
    }
  } finally {
    if (originalConfigDir === undefined) delete process.env.OASIS_CONFIG_DIR;
    else process.env.OASIS_CONFIG_DIR = originalConfigDir;
  }

  const passedCount = trials.filter((item) => item.status === 'passed').length;
  const summary = {
    runId: path.basename(startedAt).replace(/[^a-zA-Z0-9-]/g, '-') + '-' + process.pid,
    startedAt, completedAt: new Date().toISOString(),
    taskCount: selectedDirs.length, trialsPerTask: config.trials,
    passRate: trials.length ? passedCount / trials.length : 0,
    passed: passedCount, failed: trials.length - passedCount,
    provider: { model: provider.model, protocol: provider.protocol, baseURL: provider.baseURL, maxSteps: provider.maxSteps, maxOutputTokens: provider.maxOutputTokens },
    pricing: { inputUsdPerMillionTokens: inputRate, outputUsdPerMillionTokens: outputRate, note: 'Cost is a rough estimate from configured rates and does not distinguish cached tokens.' }
  };
  const resultPath = await saveResults(trials, summary, { env, resultsDir: options.resultsDir });
  output.write('Eval result: ' + resultPath + '\n');
  output.write('Pass rate: ' + passedCount + '/' + trials.length + ' (' + Math.round(summary.passRate * 100) + '%)\n');
  return { ok: trials.every((item) => item.status === 'passed'), summary, resultsPath: resultPath, results: trials };
}
