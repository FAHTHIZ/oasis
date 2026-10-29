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
  let snapshotDir = repoDir;
  const markerPath = path.join(repoDir, 'BASE_SNAPSHOT');
  const markerInfo = await lstat(markerPath).catch(() => null);
  if (markerInfo) {
    if (!markerInfo.isFile() || markerInfo.isSymbolicLink()) throw new Error(id + ': repository snapshot pointer must be a regular file');
    const snapshotId = (await readFile(markerPath, 'utf8')).trim();
    if (!safeId(snapshotId) || snapshotId !== 'oasis-main') throw new Error(id + ': unknown shared repository snapshot');
    snapshotDir = path.join(APP_ROOT, 'evals', 'snapshots', snapshotId);
    const snapshotInfo = await lstat(snapshotDir).catch(() => null);
    if (!snapshotInfo || !snapshotInfo.isDirectory() || snapshotInfo.isSymbolicLink()) throw new Error(id + ': shared repository snapshot is missing');
  }
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
  return { id, taskDir, repoDir: snapshotDir, taskPath, taskText, patchPath, verifierPath };
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


function comparisonMedian(values) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2 * 1000) / 1000;
}

function comparisonMetric(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function readComparisonRun(filePath) {
  const resolved = path.resolve(String(filePath));
  const info = await lstat(resolved).catch((error) => {
    throw new Error('Could not read comparison report "' + String(filePath) + '": ' + error.message);
  });
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Comparison report must be a regular, non-symlink file: ' + String(filePath));
  if (info.size > 10 * 1024 * 1024) throw new Error('Comparison report exceeds the 10 MiB limit: ' + String(filePath));
  let report;
  try { report = JSON.parse(await readFile(resolved, 'utf8')); }
  catch (error) { throw new Error('Invalid JSON comparison report "' + String(filePath) + '": ' + error.message); }
  if (!report || typeof report !== 'object' || Array.isArray(report) || !Array.isArray(report.results) || !report.results.length) {
    throw new Error('Comparison report must be a JSON object with a non-empty results array: ' + String(filePath));
  }

  const results = report.results.map((row, index) => {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error('Invalid result row ' + (index + 1) + ' in ' + String(filePath));
    }
    const taskId = row.taskId ?? row.id ?? row.task;
    if (!safeId(taskId)) throw new Error('Result row ' + (index + 1) + ' has an invalid taskId in ' + String(filePath));
    let passed;
    if (typeof row.passed === 'boolean') passed = row.passed;
    else {
      const status = String(row.status || '').toLowerCase();
      if (['passed', 'pass', 'success', 'succeeded'].includes(status)) passed = true;
      else if (['failed', 'fail', 'failure', 'error'].includes(status)) passed = false;
      else throw new Error('Result row ' + (index + 1) + ' must have passed=true/false or a recognized status in ' + String(filePath));
    }
    return {
      taskId,
      passed,
      wallTimeMs: comparisonMetric(row.wallTimeMs ?? row.durationMs),
      costUSD: comparisonMetric(row.costUSD ?? row.costUsd)
    };
  });
  const providerLabel = report.provider && typeof report.provider.model === 'string' ? report.provider.model : '';
  const label = String(report.label || report.name || providerLabel || path.basename(resolved)).slice(0, 100);
  return { label, source: resolved, results };
}

function summarizeComparisonTask(trials) {
  const costs = trials.map((trial) => trial.costUSD);
  const durations = trials.map((trial) => trial.wallTimeMs);
  const passed = trials.filter((trial) => trial.passed).length;
  return {
    trials: trials.length,
    passed,
    passRate: passed / trials.length,
    medianWallTimeMs: comparisonMedian(durations),
    meanCostUSD: costs.length && costs.every((cost) => cost !== null)
      ? Math.round(costs.reduce((sum, cost) => sum + cost, 0) / costs.length * 1e9) / 1e9
      : null
  };
}

/**
 * Compare saved evaluation JSON reports on task IDs present in both reports.
 * External agents can use the same neutral format: { label, results: [{ taskId,
 * status: "passed"|"failed", wallTimeMs?, costUSD? }] }. This is report-only; it
 * never starts external software or treats model-generated JSON as executable code.
 */
export async function compareEvalReports(paths, options = {}) {
  if (!Array.isArray(paths) || paths.length !== 2 || paths.some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('Usage: oasis eval --compare <run-a.json> <run-b.json>');
  }
  const output = options.output || process.stdout;
  const [left, right] = await Promise.all(paths.map(readComparisonRun));
  const leftIds = new Set(left.results.map((item) => item.taskId));
  const rightIds = new Set(right.results.map((item) => item.taskId));
  const commonIds = [...leftIds].filter((id) => rightIds.has(id)).sort();
  if (!commonIds.length) throw new Error('The reports have no matching task IDs; use the same task IDs for a fair comparison.');

  const taskRows = commonIds.map((taskId) => ({
    taskId,
    left: summarizeComparisonTask(left.results.filter((item) => item.taskId === taskId)),
    right: summarizeComparisonTask(right.results.filter((item) => item.taskId === taskId))
  }));
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const summarizeMatched = (side) => ({
    taskBalancedPassRate: mean(taskRows.map((row) => row[side].passRate)),
    medianTaskWallTimeMs: comparisonMedian(taskRows.map((row) => row[side].medianWallTimeMs)),
    meanCostPerTrialUSD: taskRows.every((row) => row[side].meanCostUSD !== null)
      ? mean(taskRows.map((row) => row[side].meanCostUSD))
      : null,
    taskCount: taskRows.length,
    trialCount: taskRows.reduce((sum, row) => sum + row[side].trials, 0)
  });
  const leftMetrics = summarizeMatched('left');
  const rightMetrics = summarizeMatched('right');
  const comparison = {
    schemaVersion: 1,
    comparedAt: new Date().toISOString(),
    sources: [{ label: left.label, file: path.basename(left.source) }, { label: right.label, file: path.basename(right.source) }],
    commonTaskCount: commonIds.length,
    onlyInA: [...leftIds].filter((id) => !rightIds.has(id)).sort(),
    onlyInB: [...rightIds].filter((id) => !leftIds.has(id)).sort(),
    metrics: {
      a: leftMetrics,
      b: rightMetrics,
      deltaBMinusA: {
        taskBalancedPassRatePercentagePoints: (rightMetrics.taskBalancedPassRate - leftMetrics.taskBalancedPassRate) * 100,
        medianTaskWallTimeMs: leftMetrics.medianTaskWallTimeMs === null || rightMetrics.medianTaskWallTimeMs === null
          ? null : rightMetrics.medianTaskWallTimeMs - leftMetrics.medianTaskWallTimeMs,
        meanCostPerTrialUSD: leftMetrics.meanCostPerTrialUSD === null || rightMetrics.meanCostPerTrialUSD === null
          ? null : rightMetrics.meanCostPerTrialUSD - leftMetrics.meanCostPerTrialUSD
      }
    },
    tasks: taskRows
  };

  const pct = (value) => value === null ? 'n/a' : (value * 100).toFixed(1) + '%';
  const ms = (value) => value === null ? 'n/a' : Math.round(value).toLocaleString('en-US') + ' ms';
  const usd = (value) => value === null ? 'n/a' : '$' + value.toFixed(6);
  const deltaPp = comparison.metrics.deltaBMinusA.taskBalancedPassRatePercentagePoints;
  const newline = String.fromCharCode(10);
  const lines = [
    'Evaluation comparison (matched tasks only)',
    'A: ' + left.label + ' [' + path.basename(left.source) + ']',
    'B: ' + right.label + ' [' + path.basename(right.source) + ']',
    'Common tasks: ' + commonIds.length + ' | A-only: ' + comparison.onlyInA.length + ' | B-only: ' + comparison.onlyInB.length,
    'Task-balanced pass rate: A ' + pct(leftMetrics.taskBalancedPassRate) + ' | B ' + pct(rightMetrics.taskBalancedPassRate) +
      ' | Delta ' + (deltaPp >= 0 ? '+' : '') + deltaPp.toFixed(1) + ' percentage points',
    'Median per-task time: A ' + ms(leftMetrics.medianTaskWallTimeMs) + ' | B ' + ms(rightMetrics.medianTaskWallTimeMs),
    'Mean cost per task/trial: A ' + usd(leftMetrics.meanCostPerTrialUSD) + ' | B ' + usd(rightMetrics.meanCostPerTrialUSD),
    '',
    'Task-level outcomes',
    'Task | A pass rate | B pass rate | A median time | B median time | A mean cost | B mean cost'
  ];
  for (const row of taskRows) {
    lines.push(row.taskId + ' | ' + row.left.passed + '/' + row.left.trials + ' (' + pct(row.left.passRate) + ')' +
      ' | ' + row.right.passed + '/' + row.right.trials + ' (' + pct(row.right.passRate) + ')' +
      ' | ' + ms(row.left.medianWallTimeMs) + ' | ' + ms(row.right.medianWallTimeMs) +
      ' | ' + usd(row.left.meanCostUSD) + ' | ' + usd(row.right.meanCostUSD));
  }
  if (comparison.onlyInA.length || comparison.onlyInB.length) {
    lines.push('', 'Note: unmatched task IDs are excluded from the headline comparison.');
  }
  output.write(lines.join(newline) + newline);
  return { ok: true, comparison };
}

function parseArgs(args) {
  const config = { validate: false, task: null, trials: 3, help: false, compare: null };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--validate') { config.validate = true; continue; }
    if (arg === '--compare') {
      if (config.compare) throw new Error('--compare may be specified only once.');
      if (!args[i + 1] || !args[i + 2]) throw new Error('--compare requires two JSON report paths.');
      config.compare = [args[++i], args[++i]];
      continue;
    }
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
  if (config.validate && (config.task || config.trials !== 3 || config.compare)) throw new Error('--validate runs the complete suite; do not combine it with --task, --trials or --compare.');
  if (config.compare && (config.task || config.trials !== 3)) throw new Error('--compare cannot be combined with --task or --trials.');
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
  try { await chmod(outputDir, 0o700); } catch {}
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
    output.write('Usage:\n  oasis eval --validate\n  oasis eval [--task ID] [--trials N] --yes\n  oasis eval --compare <run-a.json> <run-b.json>\n\n');
    output.write('Evaluation execution runs model-generated code in disposable copies. It is not OS-sandboxed. Review the task suite and only run with --yes in a controlled workspace.\n');
    return { ok: true };
  }
  if (config.compare) return await compareEvalReports(config.compare, { output });

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
          maxSteps: provider.maxSteps, maxOutputTokens: provider.maxOutputTokens ?? null,
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
  const durations = trials.map((item) => item.wallTimeMs).sort((a, b) => a - b);
  const middle = Math.floor(durations.length / 2);
  const medianTimeMs = durations.length
    ? (durations.length % 2 ? durations[middle] : Math.round((durations[middle - 1] + durations[middle]) / 2))
    : null;
  const knownCosts = trials.length > 0 && trials.every((item) => item.costUSD !== null);
  const totalCostUSD = knownCosts
    ? Math.round(trials.reduce((sum, item) => sum + item.costUSD, 0) * 1000000) / 1000000
    : null;
  const costPerPassedTaskUSD = passedCount > 0 && totalCostUSD !== null
    ? Math.round((totalCostUSD / passedCount) * 1000000) / 1000000
    : null;
  const summary = {
    runId: path.basename(startedAt).replace(/[^a-zA-Z0-9-]/g, '-') + '-' + process.pid,
    startedAt, completedAt: new Date().toISOString(),
    taskCount: selectedDirs.length, taskIds: selectedDirs.map((dir) => path.basename(dir)), trialsPerTask: config.trials,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    passRate: trials.length ? passedCount / trials.length : 0,
    passed: passedCount, failed: trials.length - passedCount,
    medianTimeMs, totalCostUSD, costPerPassedTaskUSD,
    provider: { model: provider.model, protocol: provider.protocol, baseURL: provider.baseURL, maxSteps: provider.maxSteps, maxOutputTokens: provider.maxOutputTokens ?? null },
    pricing: { inputUsdPerMillionTokens: inputRate, outputUsdPerMillionTokens: outputRate, note: 'Cost is a rough estimate from configured rates and does not distinguish cached tokens. Pass-rate differences under 10 percentage points are noisy with small task samples; run at least three trials per task when benchmarking.' }
  };
  const resultPath = await saveResults(trials, summary, { env, resultsDir: options.resultsDir });
  output.write('Eval result: ' + resultPath + '\n');
  output.write('Pass rate: ' + passedCount + '/' + trials.length + ' (' + Math.round(summary.passRate * 100) + '%)\n');
  output.write('Median time: ' + (summary.medianTimeMs === null ? 'n/a' : summary.medianTimeMs + ' ms') + '\n');
  output.write('Cost per passed trial: ' + (summary.costPerPassedTaskUSD === null ? 'n/a' : '$' + summary.costPerPassedTaskUSD.toFixed(6)) + '\n');
  return { ok: trials.every((item) => item.status === 'passed'), summary, resultsPath: resultPath, results: trials };
}
