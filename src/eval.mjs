import { createHash } from 'node:crypto';
import { credentialEnvName } from './credential-env.mjs';
import { spawn } from 'node:child_process';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfigDirectory } from './config.mjs';
import { createSession, runAgentTurn, closeSession, isLoopbackProvider } from './agent.mjs';
import { cloudModelBehindGateway, estimateCostUsd } from './pricing.mjs';
import { renderComparisonHtml, saveComparisonArtifact } from './eval-report.mjs';
import { oasisVersion } from './version.mjs';
import { redactArtifactText } from './artifacts.mjs';

// A compact, redacted record of what the agent did in a trial: tool, the
// argument that identifies the step (path, command, pattern), result size and
// whether it failed. Enough to see where a run's tokens and turns went
// without storing file contents.
const TRACE_LIMIT = 200;
const TRACE_ARG_KEYS = ['path', 'command', 'pattern', 'query', 'url', 'name', 'old_path'];
function traceStep(event) {
  const call = event && event.call;
  let args = {};
  try { args = call && call.function && typeof call.function.arguments === 'string' ? JSON.parse(call.function.arguments || '{}') : (call && call.function && call.function.arguments) || {}; } catch {}
  if (!args || typeof args !== 'object') args = {};
  const key = TRACE_ARG_KEYS.find((item) => typeof args[item] === 'string' && args[item]);
  let detail = key ? args[key] : '';
  if (!detail && Array.isArray(args.args)) detail = args.args.join(' ');
  if (key === 'command' && Array.isArray(args.args)) detail += ' ' + args.args.join(' ');
  const result = event && event.result;
  let chars = 0;
  try { chars = typeof result === 'string' ? result.length : JSON.stringify(result ?? null).length; } catch {}
  const failed = Boolean(result && typeof result === 'object' && (result.error || result.approved === false || result.blocked === true || (typeof result.exitCode === 'number' && result.exitCode !== 0)));
  return { tool: String(event && event.name || '?'), ...(detail ? { arg: redactArtifactText(detail).slice(0, 120) } : {}), resultChars: chars, ...(failed ? { failed: true } : {}) };
}
function recordTraceStep(trace, event) { if (trace.length < TRACE_LIMIT) trace.push(traceStep(event)); }

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TASKS_DIR = path.join(APP_ROOT, 'evals', 'tasks');
const DEFAULT_SNAPSHOTS_DIR = path.join(APP_ROOT, 'evals', 'snapshots');
const OUTPUT_LIMIT = 12000;
const DEFAULT_TIMEOUT_MS = 120000;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'coverage', '.turbo', '.venv', 'venv', 'vendor', 'target', '.oasis', 'eval-results', '.ssh', '.aws', '.gnupg', '.azure', '.kube', '.docker']);

// Why the agent did not report a finished task, so failed trials are explainable.
function unfinishedReason(result) {
  const flags = ['verificationIncomplete', 'tokenLimitReached', 'limitReached', 'budgetExceeded', 'stoppedByHook', 'blockedByHook'].filter((key) => result[key] === true);
  const issues = Array.isArray(result.verificationIssues) ? result.verificationIssues.slice(0, 5).map((item) => String(item && (item.message || item.text || item.kind) || item).slice(0, 300)) : [];
  return { flags, issues, text: String(result.text || '').slice(-1200) };
}

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
    if (credentialEnvName(key)) continue;
    safe[key] = value;
  }
  return safe;
}

// The agent under test gets no credentials, and git pushes from its disposable
// workspace are rewritten to a URL that cannot be reached, so a confused model
// cannot publish anything (a live run once pushed a stray branch).
export function evalAgentEnvironment(env = process.env) {
  const safe = scrubEnvironment(env);
  const blocked = ['https://', 'http://', 'ssh://', 'git://', 'git@'];
  safe.GIT_TERMINAL_PROMPT = '0';
  safe.GIT_ASKPASS = process.platform === 'win32' ? 'echo' : '/bin/false';
  safe.SSH_ASKPASS = safe.GIT_ASKPASS;
  safe.GIT_SSH_COMMAND = 'false';
  safe.GIT_CONFIG_COUNT = String(blocked.length + 1);
  blocked.forEach((prefix, index) => {
    safe['GIT_CONFIG_KEY_' + index] = 'url.file:///oasis-eval-push-blocked/.pushInsteadOf';
    safe['GIT_CONFIG_VALUE_' + index] = prefix;
  });
  safe['GIT_CONFIG_KEY_' + blocked.length] = 'credential.helper';
  safe['GIT_CONFIG_VALUE_' + blocked.length] = '';
  safe.OASIS_EVAL = '1';
  return safe;
}

function capture(output, chunk, limit = OUTPUT_LIMIT) {
  return (output + chunk.toString('utf8')).slice(-limit);
}

export function runEvalProcess(command, args, options = {}) {
  const cwd = options.cwd || process.cwd();
  const env = options.env || scrubEnvironment();
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const outputLimit = Math.max(1024, Number(options.outputLimit) || OUTPUT_LIMIT);
  return new Promise((resolve) => {
    let child;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let killTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Once timed out, keep the escalation timer even if the leader exits. A
      // descendant may have closed its inherited pipes while ignoring SIGTERM.
      if (!timedOut) clearTimeout(killTimer);
      resolve({ ...result, stdout, stderr, output: (stdout + (stderr ? '\n' + stderr : '')).slice(-outputLimit) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalProcessTree(child, 'SIGTERM');
      killTimer = setTimeout(() => { killTimer = null; signalProcessTree(child, 'SIGKILL'); }, 1000);
      killTimer.unref?.();
    }, timeoutMs);
    try {
      child = spawn(command, args, {
        cwd, env, stdio: ['ignore', 'pipe', 'pipe'], shell: false, windowsHide: true,
        ...processTreeSpawnOptions()
      });
      child.stdout.on('data', (chunk) => { stdout = capture(stdout, chunk, outputLimit); });
      child.stderr.on('data', (chunk) => { stderr = capture(stderr, chunk, outputLimit); });
      child.on('error', (error) => finish({ exitCode: 127, signal: null, error: error.message, timedOut }));
      child.on('close', (code, signal) => finish({ exitCode: timedOut ? 124 : (code ?? 1), signal, timedOut }));
    } catch (error) {
      finish({ exitCode: 127, signal: null, error: error.message, timedOut });
    }
  });
}

async function fingerprintSnapshot(source) {
  const hash = createHash('sha256');
  async function walk(directory, relative = '') {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const rel = relative ? relative + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) throw new Error('Refusing to fingerprint a snapshot containing a symbolic link: ' + rel);
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (isSensitiveName(entry.name)) continue;
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update('dir\0' + rel + '\0');
        await walk(full, rel);
      } else if (entry.isFile()) {
        const bytes = await readFile(full);
        hash.update('file\0' + rel + '\0' + bytes.length + '\0');
        hash.update(bytes);
      }
    }
  }
  await walk(source);
  return hash.digest('hex');
}

async function loadTaskMetadata(taskDir, taskId) {
  const metadataPath = path.join(path.dirname(taskDir), 'metadata.json');
  const info = await lstat(metadataPath).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!info) {
    return {
      category: 'uncategorized',
      difficulty: 'unspecified',
      rationale: 'No task metadata manifest is configured.'
    };
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Task metadata manifest must be a regular, non-symlink file.');
  if (info.size > 1024 * 1024) throw new Error('Task metadata manifest exceeds the 1 MiB limit.');
  let manifest;
  try { manifest = JSON.parse(await readFile(metadataPath, 'utf8')); }
  catch (error) { throw new Error('Task metadata manifest is invalid JSON: ' + error.message); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.schemaVersion !== 1 || !manifest.categories || typeof manifest.categories !== 'object' ||
      Array.isArray(manifest.categories) || !Array.isArray(manifest.difficulties) ||
      !manifest.tasks || typeof manifest.tasks !== 'object' || Array.isArray(manifest.tasks)) {
    throw new Error('Task metadata manifest must use schemaVersion 1 with categories, difficulties, and tasks.');
  }
  const entry = manifest.tasks[taskId];
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(taskId + ': task metadata is missing from the manifest.');
  if (typeof entry.category !== 'string' || !Object.prototype.hasOwnProperty.call(manifest.categories, entry.category)) {
    throw new Error(taskId + ': task metadata references an unknown category.');
  }
  if (typeof entry.difficulty !== 'string' || !manifest.difficulties.includes(entry.difficulty)) {
    throw new Error(taskId + ': task metadata references an unknown difficulty.');
  }
  if (typeof entry.rationale !== 'string' || !entry.rationale.trim() || entry.rationale.length > 1000) {
    throw new Error(taskId + ': task metadata rationale must be a non-empty string no longer than 1000 characters.');
  }
  return { category: entry.category, difficulty: entry.difficulty, rationale: entry.rationale };
}

async function fingerprintTask(id, taskText, patch, verifierPath, snapshotDir, metadata) {
  const snapshotHash = await fingerprintSnapshot(snapshotDir);
  const verifier = await readFile(verifierPath);
  return createHash('sha256')
    .update('oasis-eval-task-v1\0')
    .update(id + '\0')
    .update(taskText + '\0')
    .update(patch + '\0')
    .update(verifier)
    .update('\0' + snapshotHash)
    .update('\0' + JSON.stringify(metadata))
    .digest('hex');
}

async function assertTaskShape(taskDir, snapshotsDir = DEFAULT_SNAPSHOTS_DIR) {
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
    if (!safeId(snapshotId)) throw new Error(id + ': invalid shared repository snapshot ID');
    snapshotDir = path.join(path.resolve(snapshotsDir), snapshotId);
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
  const metadata = await loadTaskMetadata(taskDir, id);
  const taskFingerprint = await fingerprintTask(id, taskText, patch, verifierPath, snapshotDir, metadata);
  return { id, taskDir, repoDir: snapshotDir, taskPath, taskText, patchPath, verifierPath, taskFingerprint, ...metadata };
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

// What the agent changed, so a failed trial can be diagnosed afterwards: files
// added, modified or deleted relative to the snapshot, with bounded contents.
const CHANGE_SKIP = new Set(['.git', 'node_modules', '.oasis', '.claude']);
export async function workspaceChanges(snapshotDir, workspace, { maxFiles = 20, maxCharsPerFile = 6000, maxTotalChars = 24000 } = {}) {
  const list = async (root) => {
    const files = new Map();
    const walk = async (dir, relative) => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (CHANGE_SKIP.has(entry.name)) continue;
        const rel = relative ? relative + '/' + entry.name : entry.name;
        if (entry.isDirectory()) await walk(path.join(dir, entry.name), rel);
        else if (entry.isFile()) files.set(rel, path.join(dir, entry.name));
      }
    };
    await walk(root, '');
    return files;
  };
  const [before, after] = await Promise.all([list(snapshotDir), list(workspace)]);
  const changes = [];
  let total = 0;
  for (const [rel, file] of [...after].sort(([a], [b]) => a.localeCompare(b))) {
    const current = await readFile(file).catch(() => null);
    if (!current) continue;
    const original = before.has(rel) ? await readFile(before.get(rel)).catch(() => null) : null;
    if (original && original.equals(current)) continue;
    const binary = current.includes(0);
    const text = binary ? '' : current.toString('utf8');
    const content = binary ? '(binary, ' + current.length + ' bytes)' : text.length > maxCharsPerFile ? text.slice(0, maxCharsPerFile) + '\n[... ' + (text.length - maxCharsPerFile) + ' more characters]' : text;
    changes.push({ path: rel, status: original ? 'modified' : 'added', content: total + content.length > maxTotalChars ? '(omitted: change log size limit)' : content });
    total += content.length;
  }
  for (const rel of before.keys()) if (!after.has(rel)) changes.push({ path: rel, status: 'deleted' });
  return changes.length > maxFiles ? [...changes.slice(0, maxFiles), { path: '…', status: (changes.length - maxFiles) + ' more changed files not recorded' }] : changes;
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
  const result = await runEvalProcess(command, args, {
    cwd: workspace,
    env: scrubEnvironment(env),
    timeoutMs
  });
  return { exitCode: result.exitCode, output: result.output, timedOut: result.timedOut, error: result.error || null };
}

async function applyReferencePatch(task, workspace, env) {
  // The disposable copy intentionally excludes the source repository's .git directory.
  // Initialize a throwaway repo so git apply has consistent work-tree semantics.
  const initialized = await runEvalProcess('git', ['init', '--quiet'], {
    cwd: workspace, env: scrubEnvironment(env), timeoutMs: 20000
  });
  if (initialized.exitCode !== 0) return { ...initialized, stage: 'git-init' };
  const check = await runEvalProcess('git', ['apply', '--check', '--whitespace=error', task.patchPath], {
    cwd: workspace, env: scrubEnvironment(env), timeoutMs: 20000
  });
  if (check.exitCode !== 0) return { ...check, stage: 'check' };
  const apply = await runEvalProcess('git', ['apply', '--whitespace=error', task.patchPath], {
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
    let noOpExitCode = null;
    let referenceExitCode = null;
    try {
      task = await assertTaskShape(dir, options.snapshotsDir || DEFAULT_SNAPSHOTS_DIR);
      tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oasis-eval-validate-'));
      const noOpRoot = path.join(tempRoot, 'no-op');
      await copySnapshot(task.repoDir, noOpRoot);
      const noOp = await runVerifier(task, noOpRoot, env);
      noOpExitCode = noOp.exitCode;
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
      referenceExitCode = reference.exitCode;
      if (reference.exitCode !== 0) {
        throw new Error('Reference patch failed its verifier: ' + (reference.output || 'exit code ' + reference.exitCode));
      }
      results.push({ id: task.id, category: task.category, difficulty: task.difficulty, ok: true, noOpExitCode: noOp.exitCode, referenceExitCode: reference.exitCode, taskFingerprint: task.taskFingerprint });
    } catch (error) {
      results.push({ id: path.basename(dir), ok: false, noOpExitCode, referenceExitCode, error: error.message || String(error) });
    } finally {
      if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
  return { ok: results.length > 0 && results.every((result) => result.ok), total: results.length, results };
}

/**
 * Run the existing fixture suite without an agent: leave every snapshot untouched
 * and count any verifier that unexpectedly accepts that unchanged workspace.
 * A valid fixture must also pass its reference patch, so broken fixtures fail closed.
 */
async function runEvalNegativeControl(options = {}) {
  const report = await validateEvaluationSuite(options);

  // The reference patches are the positive control: every valid task should accept them.
  const referencePasses = report.results.filter((result) => result.referenceExitCode === 0).length;
  const total = report.total;
  const referencePassRate = total > 0 ? referencePasses / total : 0;

  // The untouched repository is the no-op negative control: it should not pass the task.
  const noOpPasses = report.results.filter((result) => result.noOpExitCode === 0).length;
  const passRate = total > 0 ? noOpPasses / total : 1;
  const threshold = 0.10;

  // A low negative score is meaningful only when it is strictly below the positive score.
  const strictlyWorse = passRate < referencePassRate;
  const ok = report.ok && passRate < threshold && strictlyWorse;
  return {
    ok,
    total,
    referencePasses,
    referencePassRate,
    noOpPasses,
    passRate,
    threshold,
    strictlyWorse,
    fixturesValid: report.ok,
    results: report.results
  };
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
    const fingerprint = row.taskFingerprint ?? row.fingerprint ?? null;
    if (fingerprint !== null && (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))) {
      throw new Error('Result row ' + (index + 1) + ' has an invalid taskFingerprint in ' + String(filePath));
    }
    const category = row.category ?? null;
    if (category !== null && (typeof category !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(category))) {
      throw new Error('Result row ' + (index + 1) + ' has an invalid category in ' + String(filePath));
    }
    const difficulty = row.difficulty ?? null;
    if (difficulty !== null && (typeof difficulty !== 'string' || !['small', 'medium', 'large', 'unspecified'].includes(difficulty))) {
      throw new Error('Result row ' + (index + 1) + ' has an invalid difficulty in ' + String(filePath));
    }
    return {
      taskId,
      taskFingerprint: fingerprint,
      passed,
      category,
      difficulty,
      wallTimeMs: comparisonMetric(row.wallTimeMs ?? row.durationMs),
      costUSD: comparisonMetric(row.costUSD ?? row.costUsd)
    };
  });
  const providerLabel = report.provider && typeof report.provider.model === 'string' ? report.provider.model : '';
  const label = String(report.label || report.name || providerLabel || path.basename(resolved)).slice(0, 100);
  const sourceRevision = typeof report.sourceRevision === 'string' && /^[a-f0-9]{40}$/i.test(report.sourceRevision)
    ? report.sourceRevision.toLowerCase()
    : null;
  return { label, source: resolved, sourceRevision, results };
}

function summarizeComparisonTask(trials) {
  const costs = trials.map((trial) => trial.costUSD);
  const durations = trials.map((trial) => trial.wallTimeMs);
  const passed = trials.filter((trial) => trial.passed).length;
  const metadataValue = (field) => {
    const values = [...new Set(trials.map((trial) => trial[field]))];
    return values.length === 1 ? values[0] : 'inconsistent';
  };
  return {
    trials: trials.length,
    passed,
    passRate: passed / trials.length,
    category: metadataValue('category'),
    difficulty: metadataValue('difficulty'),
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
  const jsonOutputPath = options.jsonOutputPath || null;
  const htmlOutputPath = options.htmlOutputPath || null;
  if (jsonOutputPath && htmlOutputPath && path.resolve(jsonOutputPath) === path.resolve(htmlOutputPath)) {
    throw new Error('JSON and HTML comparison outputs must use different paths.');
  }
  for (const reportPath of [jsonOutputPath, htmlOutputPath].filter(Boolean)) {
    if (paths.some((inputPath) => path.resolve(inputPath) === path.resolve(reportPath))) {
      throw new Error('Comparison output paths must differ from the input run report paths.');
    }
  }
  const [left, right] = await Promise.all(paths.map(readComparisonRun));
  const leftIds = new Set(left.results.map((item) => item.taskId));
  const rightIds = new Set(right.results.map((item) => item.taskId));
  const matchingIds = [...leftIds].filter((id) => rightIds.has(id)).sort();
  const fingerprintFor = (results, taskId) => {
    const rows = results.filter((item) => item.taskId === taskId);
    if (!rows.length || rows.some((row) => !row.taskFingerprint)) return null;
    const fingerprints = [...new Set(rows.map((row) => row.taskFingerprint))];
    return fingerprints.length === 1 ? fingerprints[0] : 'inconsistent';
  };
  const mismatchedFingerprints = [];
  const unverifiedFingerprints = [];
  const mismatchedMetadata = [];
  const metadataForTask = (results, taskId) => {
    const rows = results.filter((item) => item.taskId === taskId);
    const value = (field) => {
      const values = [...new Set(rows.map((row) => row[field]))];
      return values.length === 1 ? values[0] : 'inconsistent';
    };
    return { category: value('category'), difficulty: value('difficulty') };
  };
  const commonIds = matchingIds.filter((taskId) => {
    const leftMetadata = metadataForTask(left.results, taskId);
    const rightMetadata = metadataForTask(right.results, taskId);
    const metadataConflicts =
      leftMetadata.category === 'inconsistent' || rightMetadata.category === 'inconsistent' ||
      leftMetadata.difficulty === 'inconsistent' || rightMetadata.difficulty === 'inconsistent' ||
      (leftMetadata.category && rightMetadata.category && leftMetadata.category !== rightMetadata.category) ||
      (leftMetadata.difficulty && rightMetadata.difficulty && leftMetadata.difficulty !== rightMetadata.difficulty);
    if (metadataConflicts) {
      mismatchedMetadata.push(taskId);
      return false;
    }
    const leftFingerprint = fingerprintFor(left.results, taskId);
    const rightFingerprint = fingerprintFor(right.results, taskId);
    if (leftFingerprint === 'inconsistent' || rightFingerprint === 'inconsistent' ||
        (leftFingerprint && rightFingerprint && leftFingerprint !== rightFingerprint)) {
      mismatchedFingerprints.push(taskId);
      return false;
    }
    if (!leftFingerprint || !rightFingerprint) {
      unverifiedFingerprints.push(taskId);
      return false;
    }
    return true;
  });
  if (!commonIds.length) {
    throw new Error('The reports have no matching task IDs with compatible task fingerprints; use identical prompts, snapshots and verifiers.');
  }

  const taskRows = commonIds.map((taskId) => {
    const leftFingerprint = fingerprintFor(left.results, taskId);
    const rightFingerprint = fingerprintFor(right.results, taskId);
    const verified = Boolean(leftFingerprint && leftFingerprint === rightFingerprint);
    const leftTask = summarizeComparisonTask(left.results.filter((item) => item.taskId === taskId));
    const rightTask = summarizeComparisonTask(right.results.filter((item) => item.taskId === taskId));
    return {
      taskId,
      category: leftTask.category && leftTask.category !== 'inconsistent' ? leftTask.category : (rightTask.category === 'inconsistent' ? null : rightTask.category),
      difficulty: leftTask.difficulty && leftTask.difficulty !== 'inconsistent' ? leftTask.difficulty : (rightTask.difficulty === 'inconsistent' ? null : rightTask.difficulty),
      taskFingerprint: verified ? leftFingerprint : null,
      fingerprintStatus: verified ? 'verified' : 'unverified-legacy',
      left: leftTask,
      right: rightTask
    };
  });
  const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const makeBreakdown = (field) => {
    const labels = [...new Set(taskRows.map((row) => row[field] || 'uncategorized'))].sort();
    return labels.map((label) => {
      const group = taskRows.filter((row) => (row[field] || 'uncategorized') === label);
      return {
        [field]: label,
        taskCount: group.length,
        aPassRate: mean(group.map((row) => row.left.passRate)),
        bPassRate: mean(group.map((row) => row.right.passRate))
      };
    });
  };
  const categoryBreakdown = makeBreakdown('category');
  const difficultyBreakdown = makeBreakdown('difficulty');
  const completeCategories = taskRows.every((row) =>
    row.category && row.category !== 'uncategorized' &&
    row.left.category === row.category && row.right.category === row.category
  );
  const completeDifficulties = taskRows.every((row) =>
    row.difficulty && row.difficulty !== 'unspecified' &&
    row.left.difficulty === row.difficulty && row.right.difficulty === row.difficulty
  );
  const balancedPassRate = (breakdown, side, complete) => complete
    ? mean(breakdown.map((row) => row[side === 'left' ? 'aPassRate' : 'bPassRate']))
    : null;
  const summarizeMatched = (side) => ({
    taskBalancedPassRate: mean(taskRows.map((row) => row[side].passRate)),
    categoryBalancedPassRate: balancedPassRate(categoryBreakdown, side, completeCategories),
    difficultyBalancedPassRate: balancedPassRate(difficultyBreakdown, side, completeDifficulties),
    medianTaskWallTimeMs: comparisonMedian(taskRows.map((row) => row[side].medianWallTimeMs)),
    meanCostPerTrialUSD: taskRows.every((row) => row[side].meanCostUSD !== null)
      ? mean(taskRows.map((row) => row[side].meanCostUSD))
      : null,
    taskCount: taskRows.length,
    trialCount: taskRows.reduce((sum, row) => sum + row[side].trials, 0)
  });
  const leftMetrics = summarizeMatched('left');
  const rightMetrics = summarizeMatched('right');
  const pairedTaskOutcomes = { aWins: 0, bWins: 0, ties: 0 };
  for (const row of taskRows) {
    if (row.left.passRate > row.right.passRate + 1e-12) pairedTaskOutcomes.aWins++;
    else if (row.right.passRate > row.left.passRate + 1e-12) pairedTaskOutcomes.bWins++;
    else pairedTaskOutcomes.ties++;
  }
  const tasksBelowTrialMinimum = taskRows.filter((row) => row.left.trials < 3 || row.right.trials < 3).map((row) => row.taskId);
  const caveats = ['Paired task wins/ties/losses are descriptive comparisons of observed pass rates, not a statistical significance test.'];
  if (commonIds.length < 50) caveats.push('Only ' + commonIds.length + ' matched task' + (commonIds.length === 1 ? '' : 's') + ' are included; the benchmark guide targets at least 50 representative tasks before broad parity claims.');
  if (tasksBelowTrialMinimum.length) caveats.push('At least one matched task has fewer than 3 trials in one or both reports (' + tasksBelowTrialMinimum.length + ' task(s)); repeat trials before drawing strong conclusions.');
  if (unverifiedFingerprints.length) caveats.push(unverifiedFingerprints.length + ' matched task(s) lack matching verified fingerprints and were compared by task ID only.');
  if (mismatchedFingerprints.length) caveats.push(mismatchedFingerprints.length + ' task(s) with incompatible fingerprints were excluded.');
  if (mismatchedMetadata.length) caveats.push(mismatchedMetadata.length + ' task(s) with conflicting category/difficulty metadata were excluded.');
  if (!left.sourceRevision || !right.sourceRevision) caveats.push('At least one run has no verified 40-character source revision; the comparison is not fully revision-pinned.');
  if (!completeCategories) caveats.push('Some matched tasks lack consistent category metadata; category-balanced pass rate is unavailable.');
  if (!completeDifficulties) caveats.push('Some matched tasks lack consistent difficulty metadata; difficulty-balanced pass rate is unavailable.');
  if (!taskRows.some((row) => row.difficulty === 'large')) caveats.push('No matched task is labeled large; the result does not establish performance on large repository-level work.');
  if (taskRows.some((row) => row.left.meanCostUSD === null || row.right.meanCostUSD === null)) caveats.push('Per-task cost is incomplete for at least one side; missing cost is unknown, not zero.');
  const comparison = {
    schemaVersion: 1,
    comparedAt: new Date().toISOString(),
    sources: [{ label: left.label, file: path.basename(left.source), revision: left.sourceRevision }, { label: right.label, file: path.basename(right.source), revision: right.sourceRevision }],
    commonTaskCount: commonIds.length,
    pairedTaskOutcomes,
    caveats,
    methodology: {
      primaryMetric: 'Macro-average of per-task observed pass rates; every matched task receives equal weight.',
      pairedTaskOutcomes: 'For each matched task, compare observed pass rates across recorded trials. Counts are descriptive, not a statistical significance test.',
      minimumRecommendedTasks: 50,
      minimumRecommendedTrialsPerTask: 3
    },
    mismatchedFingerprints,
    mismatchedMetadata,
    unverifiedFingerprints,
    categoryBreakdown,
    difficultyBreakdown,
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
          ? null : rightMetrics.meanCostPerTrialUSD - leftMetrics.meanCostPerTrialUSD,
        categoryBalancedPassRatePercentagePoints: leftMetrics.categoryBalancedPassRate === null || rightMetrics.categoryBalancedPassRate === null
          ? null : (rightMetrics.categoryBalancedPassRate - leftMetrics.categoryBalancedPassRate) * 100,
        difficultyBalancedPassRatePercentagePoints: leftMetrics.difficultyBalancedPassRate === null || rightMetrics.difficultyBalancedPassRate === null
          ? null : (rightMetrics.difficultyBalancedPassRate - leftMetrics.difficultyBalancedPassRate) * 100
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
    'A: ' + left.label + ' [' + path.basename(left.source) + ']' + (left.sourceRevision ? ' (revision ' + left.sourceRevision + ')' : ' (revision unavailable)'),
    'B: ' + right.label + ' [' + path.basename(right.source) + ']' + (right.sourceRevision ? ' (revision ' + right.sourceRevision + ')' : ' (revision unavailable)'),
    'Common tasks: ' + commonIds.length + ' | A-only: ' + comparison.onlyInA.length + ' | B-only: ' + comparison.onlyInB.length,
    'Task fingerprints: ' + taskRows.filter((row) => row.fingerprintStatus === 'verified').length + '/' + taskRows.length + ' verified; ' + mismatchedFingerprints.length + ' fingerprint-mismatched task(s) excluded; ' + mismatchedMetadata.length + ' metadata-mismatched task(s) excluded; ' + unverifiedFingerprints.length + ' legacy/unfingerprinted task(s) excluded from headline metrics.',
    'Task-balanced pass rate: A ' + pct(leftMetrics.taskBalancedPassRate) + ' | B ' + pct(rightMetrics.taskBalancedPassRate) +
      ' | Delta ' + (deltaPp >= 0 ? '+' : '') + deltaPp.toFixed(1) + ' percentage points',
    'Category-balanced pass rate: A ' + pct(leftMetrics.categoryBalancedPassRate) + ' | B ' + pct(rightMetrics.categoryBalancedPassRate),
    'Difficulty-balanced pass rate: A ' + pct(leftMetrics.difficultyBalancedPassRate) + ' | B ' + pct(rightMetrics.difficultyBalancedPassRate),
    'Median per-task time: A ' + ms(leftMetrics.medianTaskWallTimeMs) + ' | B ' + ms(rightMetrics.medianTaskWallTimeMs),
    'Mean cost per task/trial: A ' + usd(leftMetrics.meanCostPerTrialUSD) + ' | B ' + usd(rightMetrics.meanCostPerTrialUSD),
    'Paired task outcomes by observed pass rate: A wins ' + pairedTaskOutcomes.aWins + ' | B wins ' + pairedTaskOutcomes.bWins + ' | ties ' + pairedTaskOutcomes.ties,
    '',
    'Category breakdown: ' + categoryBreakdown.map((row) => row.category + ' (' + row.taskCount + ' tasks)').join(', '),
    'Difficulty breakdown: ' + difficultyBreakdown.map((row) => row.difficulty + ' (' + row.taskCount + ' tasks)').join(', '),
    '',
    'Task-level outcomes',
    'Task | Category | Difficulty | A pass rate | B pass rate | A median time | B median time | A mean cost | B mean cost'
  ];
  for (const row of taskRows) {
    lines.push(row.taskId + ' | ' + (row.category || 'uncategorized') + ' | ' + (row.difficulty || 'unspecified') + ' | ' + row.left.passed + '/' + row.left.trials + ' (' + pct(row.left.passRate) + ')' +
      ' | ' + row.right.passed + '/' + row.right.trials + ' (' + pct(row.right.passRate) + ')' +
      ' | ' + ms(row.left.medianWallTimeMs) + ' | ' + ms(row.right.medianWallTimeMs) +
      ' | ' + usd(row.left.meanCostUSD) + ' | ' + usd(row.right.meanCostUSD));
  }
  if (comparison.onlyInA.length || comparison.onlyInB.length) {
    lines.push('', 'Note: unmatched task IDs are excluded from the headline comparison.');
  }
  if (comparison.caveats.length) {
    lines.push('', 'Interpretation guardrails');
    for (const caveat of comparison.caveats) lines.push('  NOTE ' + caveat);
  }
  let jsonReportPath = null;
  let htmlReportPath = null;
  if (jsonOutputPath) {
    jsonReportPath = await saveComparisonArtifact(jsonOutputPath, JSON.stringify(comparison, null, 2) + newline);
    lines.push('JSON report saved: ' + jsonReportPath);
  }
  if (htmlOutputPath) {
    htmlReportPath = await saveComparisonArtifact(htmlOutputPath, renderComparisonHtml(comparison));
    lines.push('HTML report saved: ' + htmlReportPath);
  }
  output.write(lines.join(newline) + newline);
  return { ok: true, comparison, jsonReportPath, htmlReportPath };
}

function parseArgs(args) {
  const config = {
    validate: false, negativeControl: false, task: null, trials: 3, help: false, compare: null, compareOutput: null, compareHtml: null,
    claudeCode: false, model: null, maxTurns: 30, timeoutSeconds: 600,
    timeoutExplicit: false, budgetUSD: null, claudeOptionsUsed: false, routeEasyModel: null, routeStrongModel: null, routeMode: 'classify', routingOptionsUsed: false
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--validate') { config.validate = true; continue; }
    if (arg === '--negative-control') { config.negativeControl = true; continue; }
    if (arg === '--compare') {
      if (config.compare) throw new Error('--compare may be specified only once.');
      if (!args[i + 1] || !args[i + 2]) throw new Error('--compare requires two JSON report paths.');
      config.compare = [args[++i], args[++i]];
      continue;
    }
    if (arg === '--out' || arg === '--html') {
      const option = arg === '--out' ? 'compareOutput' : 'compareHtml';
      const label = arg === '--out' ? '--out' : '--html';
      if (config[option]) throw new Error(label + ' may be specified only once.');
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(label + ' requires an output file path.');
      config[option] = value;
      continue;
    }
    if (arg === '--route-mode') {
      const value = args[++i];
      if (value !== 'cascade' && value !== 'classify') throw new Error('--route-mode must be cascade or classify.');
      config.routeMode = value;
      config.routingOptionsUsed = true;
      continue;
    }
    if (arg === '--route-easy-model' || arg === '--route-strong-model') {
      const value = args[++i];
      if (!value || value.startsWith('--') || value.length > 200 || /[\r\n\0]/.test(value)) {
        throw new Error(arg + ' requires a model ID up to 200 characters.');
      }
      if (arg === '--route-easy-model') config.routeEasyModel = value;
      else config.routeStrongModel = value;
      config.routingOptionsUsed = true;
      continue;
    }
    if (arg === '--claude-code' || arg === '--codex' || arg === '--gemini-cli' || arg === '--opencode' || arg === '--aider') {
      const agent = { '--codex': 'codex', '--gemini-cli': 'gemini', '--opencode': 'opencode', '--aider': 'aider' }[arg] || 'claude';
      if (config.claudeCode && config.externalAgent !== agent) throw new Error('Choose one external agent: --claude-code, --codex, --gemini-cli, --opencode or --aider.');
      config.claudeCode = true;
      config.externalAgent = agent;
      continue;
    }
    if (arg === '--model') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error('--model requires a model name or alias for the external agent.');
      config.model = args[++i];
      config.claudeOptionsUsed = true;
      continue;
    }
    if (arg === '--max-turns') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 200) throw new Error('--max-turns must be an integer from 1 to 200.');
      config.maxTurns = value;
      config.claudeOptionsUsed = true;
      config.claudeOnlyOptionUsed = true;
      continue;
    }
    if (arg === '--timeout-seconds') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 30 || value > 3600) throw new Error('--timeout-seconds must be an integer from 30 to 3600.');
      config.timeoutSeconds = value;
      config.timeoutExplicit = true;
      continue;
    }
    if (arg === '--budget-usd') {
      const value = Number(args[++i]);
      if (!Number.isFinite(value) || value <= 0 || value > 1000) throw new Error('--budget-usd must be greater than 0 and no more than 1000.');
      config.budgetUSD = value;
      config.claudeOptionsUsed = true;
      config.claudeOnlyOptionUsed = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') { config.help = true; continue; }
    if (arg === '--task') {
      if (!args[i + 1]) throw new Error('--task requires an evaluation task ID.');
      config.task = args[++i];
      continue;
    }
    if (arg === '--trials') {
      const raw = args[++i];
      if (!/^\d+$/.test(String(raw ?? ''))) {
        throw new Error('--trials must be an integer from 1 to 10.');
      }
      const value = Number(raw);
      if (!Number.isSafeInteger(value) || value < 1 || value > 10) {
        throw new Error('--trials must be an integer from 1 to 10.');
      }
      config.trials = value;
      continue;
    }
    throw new Error('Unknown oasis eval option: ' + arg);
  }
  if (config.task && !String(config.task).split(',').every((id) => safeId(id))) throw new Error('Task IDs may contain lowercase letters, numbers, and hyphens (separate several with commas).');
  if ((config.compareOutput || config.compareHtml) && !config.compare) {
    throw new Error('--out and --html are only valid with --compare.');
  }
  if (config.compareOutput && config.compareHtml && path.resolve(config.compareOutput) === path.resolve(config.compareHtml)) {
    throw new Error('JSON and HTML comparison outputs must use different paths.');
  }
  if (config.claudeOptionsUsed && !config.claudeCode) {
    throw new Error('--model, --max-turns and --budget-usd require --claude-code (or --codex / --gemini-cli for --model).');
  }
  if (config.claudeOnlyOptionUsed && config.externalAgent && config.externalAgent !== 'claude') {
    throw new Error('--max-turns and --budget-usd are Claude Code options; --codex and --gemini-cli accept --model and --timeout-seconds.');
  }
  if (config.routingOptionsUsed && config.claudeCode) {
    throw new Error('--route-easy-model and --route-strong-model apply only to OASIS eval runs, not --claude-code.');
  }
  if (config.routeMode === 'cascade' && !config.routeEasyModel) {
    throw new Error('--route-mode cascade requires --route-easy-model.');
  }
  if (config.routeStrongModel && !config.routeEasyModel) {
    throw new Error('--route-strong-model requires --route-easy-model.');
  }

  if (config.validate && config.routingOptionsUsed) throw new Error('--validate cannot be combined with model-routing options.');
  if (config.compare && config.routingOptionsUsed) throw new Error('--compare cannot be combined with model-routing options.');
  if (config.claudeCode && (config.validate || config.negativeControl || config.compare)) {
    throw new Error('--claude-code cannot be combined with --validate or --compare.');
  }
  if (config.validate && (config.negativeControl || config.task || config.trials !== 3 || config.compare || config.claudeCode || config.timeoutExplicit || config.compareOutput || config.compareHtml)) throw new Error('--validate runs the complete suite; do not combine it with --negative-control, --task, --trials, --compare, --timeout-seconds, --out, --html or --claude-code.');
  if (config.negativeControl && (config.validate || config.task || config.trials !== 3 || config.compare || config.claudeCode || config.timeoutExplicit || config.compareOutput || config.compareHtml)) throw new Error('--negative-control runs the complete unchanged-snapshot control; do not combine it with --validate, --task, --trials, --compare, --timeout-seconds, --out, --html or --claude-code.');
  if (config.compare && (config.task || config.trials !== 3 || config.claudeCode || config.timeoutExplicit)) throw new Error('--compare cannot be combined with --task, --trials, --timeout-seconds or --claude-code.');
  return config;
}

function readPrice(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function detectSourceRevision(env = process.env) {
  const explicit = String(env.OASIS_SOURCE_REVISION || env.GITHUB_SHA || '').trim();
  if (/^[a-f0-9]{40}$/i.test(explicit)) return explicit.toLowerCase();

  const result = await runEvalProcess('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd: APP_ROOT,
    env: scrubEnvironment(env),
    timeoutMs: 3000,
    outputLimit: 1024
  });
  const revision = result.exitCode === 0 ? String(result.stdout || '').trim() : '';
  return /^[a-f0-9]{40}$/i.test(revision) ? revision.toLowerCase() : null;
}

function costEstimate(inputTokens, outputTokens, inputRate, outputRate) {
  if (inputRate === null || outputRate === null) return null;
  return Math.round(((inputTokens * inputRate + outputTokens * outputRate) / 1000000) * 1000000) / 1000000;
}


function finiteMetric(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) return number;
  }
  return null;
}

function sumUsageRecords(modelUsage, keys) {
  if (!modelUsage || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return null;
  const records = Object.values(modelUsage).filter((value) => value && typeof value === 'object' && !Array.isArray(value));
  if (!records.length || !records.some((record) => keys.some((key) => record[key] !== undefined && record[key] !== null))) return null;
  return records.reduce((sum, record) => sum + (finiteMetric(...keys.map((key) => record[key])) || 0), 0);
}

/** Parse the JSON object emitted by Claude Code print mode without guessing missing metrics. */
export function parseClaudeCodeOutput(rawOutput) {
  let payload;
  try {
    payload = JSON.parse(String(rawOutput || '').trim());
  } catch (error) {
    throw new Error('Claude Code did not return a valid JSON result: ' + error.message);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Claude Code JSON result must be an object.');
  }

  const usage = payload.usage && typeof payload.usage === 'object' ? payload.usage : {};
  const modelUsage = payload.modelUsage || payload.model_usage || null;
  const inputTokens = finiteMetric(
    sumUsageRecords(modelUsage, ['inputTokens', 'input_tokens']),
    usage.input_tokens, usage.inputTokens, payload.input_tokens, payload.inputTokens
  );
  const outputTokens = finiteMetric(
    sumUsageRecords(modelUsage, ['outputTokens', 'output_tokens']),
    usage.output_tokens, usage.outputTokens, payload.output_tokens, payload.outputTokens
  );
  const modelCosts = sumUsageRecords(modelUsage, ['costUSD', 'cost_usd', 'total_cost_usd']);
  // cost_known: false (OASIS on an unpriced model) means the total counts only
  // priced requests, so the trial's cost is unknown, not zero.
  const costUSD = payload.cost_known === false ? null : finiteMetric(payload.total_cost_usd, payload.totalCostUSD, payload.costUSD, payload.cost_usd,
    usage.total_cost_usd, usage.costUSD, modelCosts);
  const model = typeof payload.model === 'string' && payload.model.trim()
    ? payload.model.trim()
    : modelUsage && typeof modelUsage === 'object' && !Array.isArray(modelUsage)
      ? Object.keys(modelUsage).filter(Boolean).sort().join(', ') || null
      : null;
  const resultText = typeof payload.result === 'string' ? payload.result
    : typeof payload.message === 'string' ? payload.message
      : typeof payload.error === 'string' ? payload.error : '';
  const numTurns = finiteMetric(payload.num_turns, payload.numTurns);
  return {
    model,
    inputTokens,
    outputTokens,
    totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    costUSD,
    durationMs: finiteMetric(payload.duration_ms, payload.durationMs),
    numTurns,
    result: resultText,
    isError: payload.is_error === true || payload.isError === true || payload.subtype === 'error'
  };
}

function buildClaudeCodeArgs(config, prompt) {
  const args = [
    '-p',
    '--output-format', 'json',
    '--no-session-persistence',
    '--restricted',
    '--permission-mode', 'dontAsk',
    '--max-turns', String(config.maxTurns || 30),
    '--tools', 'Read,Edit,Write,Glob,Grep,Bash',
    '--allowedTools',
    'Read', 'Edit', 'Write', 'Glob', 'Grep',
    'Bash(npm test *)', 'Bash(npm run check *)',
    'Bash(git diff *)', 'Bash(git status *)'
  ];
  if (config.model) args.push('--model', config.model);
  if (config.budgetUSD !== null && config.budgetUSD !== undefined) args.push('--max-budget-usd', String(config.budgetUSD));
  args.push(prompt);
  return args;
}

/** Parse `codex exec --json` JSONL: usage from turn.completed, answer from the last agent_message. */
function parseCodexOutput(rawOutput) {
  let inputTokens = null; let outputTokens = null; let result = ''; let isError = false; let toolCalls = 0; let model = null; let events = 0;
  for (const line of String(rawOutput || '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(text); } catch { continue; }
    events++;
    if (event.type === 'turn.completed' && event.usage) {
      inputTokens = (inputTokens || 0) + (finiteMetric(event.usage.input_tokens) || 0);
      outputTokens = (outputTokens || 0) + (finiteMetric(event.usage.output_tokens) || 0) + (finiteMetric(event.usage.reasoning_output_tokens) || 0);
    }
    if (event.type === 'turn.failed' || event.type === 'error') { isError = true; result = String((event.error && event.error.message) || event.message || result || 'Codex reported an error.'); }
    if (event.type === 'thread.started' && typeof event.model === 'string') model = event.model;
    if (event.type === 'item.completed' && event.item) {
      if (event.item.type === 'agent_message' && typeof event.item.text === 'string') result = event.item.text;
      else if (['command_execution', 'file_change', 'mcp_tool_call', 'web_search'].includes(event.item.type)) toolCalls++;
    }
  }
  if (!events) throw new Error('Codex did not return JSONL events (is this codex exec --json?).');
  return { model, inputTokens, outputTokens, totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens, costUSD: null, durationMs: null, numTurns: toolCalls, result, isError };
}

/** Parse `gemini -p --output-format json`: { response, stats: { models: { name: { tokens } }, tools }, error }. */
// The most useful error in an agent's output: the last JSON error event
// (OpenCode's {"type":"error"}, Gemini CLI's {"error":{...}}), or else the last
// line that names an HTTP or quota problem. Raw JSON tails are unreadable.
export function agentErrorSummary(output) {
  const text = String(output || '');
  const messageOf = (value) => {
    if (!value || typeof value !== 'object') return '';
    const error = value.error && typeof value.error === 'object' ? value.error : value.type === 'error' ? value : null;
    if (!error) return '';
    const data = error.data && typeof error.data === 'object' ? error.data : {};
    let message = String(data.message || error.message || error.name || '');
    try { const inner = JSON.parse(message.replace(/^[^[{]*/, '')); const nested = messageOf(Array.isArray(inner) ? inner[0] : inner); if (nested) message = nested; } catch {}
    const code = data.statusCode || error.code || error.status;
    return (code && !String(message).includes(String(code)) ? 'HTTP ' + code + ': ' : '') + message;
  };
  let found = '';
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try { const message = messageOf(JSON.parse(trimmed)); if (message) found = message; } catch {}
  }
  if (!found) {
    // A pretty-printed object that starts at the beginning of a line.
    const starts = [...text.matchAll(/(?:^|\n)\{/g)].map((match) => match.index + (match[0].length - 1)).reverse();
    for (const start of starts) {
      const end = text.indexOf('\n}', start);
      if (end < 0) continue;
      try { found = messageOf(JSON.parse(text.slice(start, end + 2))); } catch {}
      if (found) break;
    }
  }
  if (!found) {
    const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => /\b(?:4\d\d|5\d\d)\b|quota|rate limit|exceeded|unavailable|high demand|ECONN|ETIMEDOUT/i.test(line) && line.length < 600);
    found = lines.length ? lines[lines.length - 1] : '';
  }
  return found.replace(/\s+/g, ' ').trim().slice(0, 400);
}

function parseGeminiOutput(rawOutput) {
  const raw = String(rawOutput || '');
  const start = raw.indexOf('{'); const end = raw.lastIndexOf('}');
  let payload;
  try { payload = JSON.parse(raw.slice(start, end + 1)); } catch (error) { throw new Error('Gemini CLI did not return a valid JSON result: ' + error.message); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Gemini CLI JSON result must be an object.');
  const models = payload.stats && payload.stats.models && typeof payload.stats.models === 'object' ? payload.stats.models : {};
  const tokens = Object.values(models).map((entry) => (entry && entry.tokens) || {});
  const inputTokens = tokens.length ? tokens.reduce((sum, t) => sum + (finiteMetric(t.prompt, t.input) || 0), 0) : null;
  const outputTokens = tokens.length ? tokens.reduce((sum, t) => sum + (finiteMetric(t.candidates, t.output) || 0) + (finiteMetric(t.thoughts) || 0), 0) : null;
  const error = payload.error ? (typeof payload.error === 'string' ? payload.error : payload.error.message || JSON.stringify(payload.error)) : '';
  return {
    model: Object.keys(models).sort().join(', ') || null,
    inputTokens, outputTokens, totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens,
    costUSD: null, durationMs: null,
    numTurns: finiteMetric(payload.stats && payload.stats.tools && payload.stats.tools.totalCalls),
    result: typeof payload.response === 'string' ? payload.response : error,
    isError: Boolean(error)
  };
}

export function buildCodexArgs(config, prompt, env = process.env) {
  // workspace-write keeps Codex's default network-off sandbox, matching the benchmark rule of no network.
  // Codex 0.1xx ignores OPENAI_BASE_URL, so a gateway needs its own provider entry.
  const base = String(env.OASIS_CODEX_BASE_URL || '').trim();
  const provider = base ? ['-c', 'model_provider=bench', '-c', 'model_providers.bench.name=' + JSON.stringify('bench'), '-c', 'model_providers.bench.base_url=' + JSON.stringify(base), '-c', 'model_providers.bench.env_key=' + JSON.stringify('OPENAI_API_KEY'), '-c', 'model_providers.bench.wire_api=' + JSON.stringify('responses')] : [];
  return ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', ...provider, ...(config.model ? ['-m', config.model] : []), prompt];
}

function buildGeminiArgs(config, prompt) {
  // yolo auto-approves tools; Gemini CLI turns its own sandbox on with it (set GEMINI_SANDBOX=false if no container runtime).
  return ['-p', prompt, '--output-format', 'json', '--approval-mode', 'yolo', ...(config.model ? ['-m', config.model] : [])];
}

function humanTokens(text) {
  const match = String(text || '').trim().match(/^([\d.,]+)\s*([km]?)$/i);
  if (!match) return null;
  const value = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return Math.round(value * (match[2].toLowerCase() === 'k' ? 1000 : match[2].toLowerCase() === 'm' ? 1000000 : 1));
}

/** Parse `opencode run --format json` JSONL. Pass/fail comes from the verifier, so this only gathers stats and never throws on unknown events. */
export function parseOpenCodeOutput(rawOutput) {
  let inputTokens = null; let outputTokens = null; let costUSD = null; let result = ''; let isError = false; let toolCalls = 0; let model = null; let events = 0;
  for (const line of String(rawOutput || '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(text); } catch { continue; }
    events++;
    const part = event.part && typeof event.part === 'object' ? event.part : event;
    const type = String(event.type || part.type || '');
    if (part.tokens && typeof part.tokens === 'object') {
      inputTokens = (inputTokens || 0) + (finiteMetric(part.tokens.input) || 0);
      outputTokens = (outputTokens || 0) + (finiteMetric(part.tokens.output) || 0) + (finiteMetric(part.tokens.reasoning) || 0);
    }
    if (typeof part.cost === 'number' && Number.isFinite(part.cost)) costUSD = (costUSD || 0) + part.cost;
    if (typeof part.modelID === 'string') model = (part.providerID ? part.providerID + '/' : '') + part.modelID;
    if (type === 'text' && typeof part.text === 'string') result = part.text;
    if (type === 'tool_use' || type === 'tool') toolCalls++;
    if (type === 'error') { isError = true; result = String((event.error && (event.error.message || event.error.data && event.error.data.message)) || event.message || 'OpenCode reported an error.'); }
  }
  if (!events) result = String(rawOutput || '').trim().slice(-4000);
  return { model, inputTokens, outputTokens, totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens, costUSD, durationMs: null, numTurns: toolCalls || null, result, isError };
}

/** Parse Aider's plain-text output: "Tokens: 4.2k sent, 310 received. Cost: $0.01 message, $0.03 session." */
export function parseAiderOutput(rawOutput) {
  const raw = String(rawOutput || '');
  let inputTokens = null; let outputTokens = null; let costUSD = null;
  for (const match of raw.matchAll(/Tokens:\s*([\d.,]+\s*[km]?)\s*sent,\s*([\d.,]+\s*[km]?)\s*received/gi)) {
    inputTokens = (inputTokens || 0) + (humanTokens(match[1]) || 0);
    outputTokens = (outputTokens || 0) + (humanTokens(match[2]) || 0);
  }
  const sessionCosts = [...raw.matchAll(/\$([\d.]+)\s*session/gi)];
  if (sessionCosts.length) costUSD = Number(sessionCosts.at(-1)[1]);
  const model = (raw.match(/^Main model:\s*(\S+)/m) || raw.match(/^Model:\s*(\S+)/m) || [])[1] || null;
  return { model, inputTokens, outputTokens, totalTokens: inputTokens === null || outputTokens === null ? null : inputTokens + outputTokens, costUSD: Number.isFinite(costUSD) ? costUSD : null, durationMs: null, numTurns: null, result: raw.trim().slice(-4000), isError: false };
}

export function buildOpenCodeArgs(config, prompt) {
  return ['run', '--format', 'json', ...(config.model ? ['-m', config.model] : []), prompt];
}

const EXTERNAL_AGENT_FLAGS = ['--claude-code', '--codex', '--gemini-cli', '--opencode', '--aider'];

// `oasis eval ... --model X` arrives with --model already removed by the CLI's
// global parser. Route it to the external agent, or to OASIS's provider config.
export function evalModelPassthrough(args, model, env = process.env) {
  const list = Array.isArray(args) ? [...args] : [];
  if (!model || list.includes('--model')) return { args: list, env };
  if (list.some((arg) => EXTERNAL_AGENT_FLAGS.includes(arg))) return { args: [...list, '--model', String(model)], env };
  return { args: list, env: { ...env, OASIS_MODEL: String(model) } };
}

// Aider sends one non-streaming request per reply. litellm's default request
// timeout (600 s) cuts off slow local models long before the task limit, so the
// per-request timeout follows the task timeout, as OASIS's own requests do.
export function buildAiderArgs(config, prompt) {
  const seconds = Number(config.timeoutSeconds);
  return ['--message', prompt, '--yes-always', '--no-auto-commits', '--no-dirty-commits', '--no-check-update', '--no-analytics', '--no-show-model-warnings', '--no-pretty', '--no-stream',
    ...(Number.isFinite(seconds) && seconds > 0 ? ['--timeout', String(Math.ceil(seconds))] : []),
    ...(config.model ? ['--model', config.model] : [])];
}

export const EXTERNAL_AGENTS = {
  claude: { name: 'Claude Code', flag: '--claude-code', binEnv: 'OASIS_CLAUDE_CODE_BIN', bin: 'claude', protocol: 'claude-code-cli', tempPrefix: 'oasis-claude-eval-', buildArgs: (config, prompt) => buildClaudeCodeArgs(config, prompt), parse: (raw) => parseClaudeCodeOutput(raw), checkVersion: (v) => versionSupportsRestrictedMode(v) ? '' : 'Claude Code ' + (v || '(unknown version)') + ' is too old or unrecognized. This benchmark requires Claude Code v2.1.248 or newer for restricted mode.', install: 'Install Claude Code, ensure it is on PATH, and sign in.' },
  codex: { name: 'Codex CLI', flag: '--codex', binEnv: 'OASIS_CODEX_BIN', bin: 'codex', protocol: 'codex-cli', tempPrefix: 'oasis-codex-eval-', buildArgs: buildCodexArgs, parse: parseCodexOutput, checkVersion: () => '', install: 'Install the Codex CLI (npm i -g @openai/codex), ensure it is on PATH, and sign in.' },
  gemini: { name: 'Gemini CLI', flag: '--gemini-cli', binEnv: 'OASIS_GEMINI_CLI_BIN', bin: 'gemini', protocol: 'gemini-cli', tempPrefix: 'oasis-gemini-eval-', buildArgs: buildGeminiArgs, parse: parseGeminiOutput, checkVersion: () => '', install: 'Install Gemini CLI (npm i -g @google/gemini-cli), ensure it is on PATH, and sign in.' },
  opencode: { name: 'OpenCode', flag: '--opencode', binEnv: 'OASIS_OPENCODE_BIN', bin: 'opencode', protocol: 'opencode-cli', tempPrefix: 'oasis-opencode-eval-', buildArgs: buildOpenCodeArgs, parse: parseOpenCodeOutput, checkVersion: () => '', install: 'Install OpenCode (npm i -g opencode-ai), ensure it is on PATH, and configure a provider.' },
  aider: { name: 'Aider', flag: '--aider', binEnv: 'OASIS_AIDER_BIN', bin: 'aider', protocol: 'aider-cli', tempPrefix: 'oasis-aider-eval-', buildArgs: buildAiderArgs, parse: parseAiderOutput, checkVersion: () => '', install: 'Install Aider (python -m pip install aider-install && aider-install), ensure it is on PATH, and configure a model key.' }
};

function versionSupportsRestrictedMode(versionText) {
  const match = String(versionText || '').match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && minor > 1) || (major === 2 && minor === 1 && patch >= 248);
}

async function runClaudeCodeEval(config, options = {}) {
  const output = options.output || process.stdout;
  const adapter = EXTERNAL_AGENTS[config.externalAgent || 'claude'];
  const agentName = adapter.name;
  if (!options.autoApprove) {
    throw new Error(agentName + ' evaluation runs an external coding agent against disposable task copies. Review the task suite, then explicitly run oasis eval ' + adapter.flag + ' --yes [--task ID] [--trials N].');
  }
  const env = options.env || process.env;
  const tasksDir = options.tasksDir || DEFAULT_TASKS_DIR;
  const allDirs = await listTaskDirectories(tasksDir);
  const wanted = config.task ? String(config.task).split(',') : null;
  const selectedDirs = wanted ? allDirs.filter((dir) => wanted.includes(path.basename(dir))) : allDirs;
  const missingTask = wanted && wanted.find((id) => !selectedDirs.some((dir) => path.basename(dir) === id));
  if (missingTask) throw new Error('No evaluation task named "' + missingTask + '" was found.');
  if (!selectedDirs.length) throw new Error('No evaluation tasks were found in ' + tasksDir);

  const command = String(env[adapter.binEnv] || adapter.bin);
  const runCli = options.claudeRunner || ((args, runnerOptions) => runEvalProcess(command, args, runnerOptions));
  const versionResult = await runCli(['--version'], {
    cwd: APP_ROOT, env, timeoutMs: 15000, outputLimit: 20000
  });
  if (versionResult.exitCode !== 0 || versionResult.timedOut || versionResult.error) {
    throw new Error('Could not start the ' + agentName + ' CLI (' + command + '). ' + adapter.install + ' ' +
      (versionResult.error || versionResult.output || 'CLI version check failed.'));
  }
  const cliVersion = String(versionResult.stdout || '').trim().split(/\r?\n/).slice(0, 2).join(' ').slice(0, 120);
  const versionProblem = adapter.checkVersion(cliVersion);
  if (versionProblem) throw new Error(versionProblem);

  const startedAt = new Date().toISOString();
  const trials = [];
  for (const dir of selectedDirs) {
    const task = await assertTaskShape(dir, options.snapshotsDir || DEFAULT_SNAPSHOTS_DIR);
    for (let trial = 1; trial <= config.trials; trial++) {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), adapter.tempPrefix));
      const workspace = path.join(tempRoot, 'workspace');
      const trialStarted = Date.now();
      let errorText = null;
      let cliResult = null;
      let parsed = null;
      let verification = { exitCode: 1, output: 'Agent did not complete.' };
      try {
        await copySnapshot(task.repoDir, workspace);
        const prompt = task.taskText.trim() + '\n\nBenchmark constraints: solve this task using only the current workspace. Do not access files outside this workspace, use the network, change the task harness, or bypass verification. The harness runs the task verifier independently after you finish.';
        cliResult = await runCli(adapter.buildArgs(config, prompt, env), {
          cwd: workspace,
          // OpenCode (and other Bun/shell-based CLIs) take the project from
          // $PWD, not the process cwd; an inherited PWD sent it to edit the
          // directory the benchmark was started from.
          env: { ...env, PWD: workspace },
          timeoutMs: config.timeoutSeconds * 1000,
          outputLimit: 1024 * 1024
        });
        try {
          parsed = adapter.parse(cliResult.stdout);
        } catch (error) {
          const cause = agentErrorSummary(cliResult.output || cliResult.stderr || '');
          errorText = (error.message || String(error)) + (cause ? ' (' + agentName + ' reported: ' + cause + ')' : '');
        }
        if (!errorText && cliResult.timedOut) errorText = agentName + ' exceeded the ' + config.timeoutSeconds + '-second task timeout.';
        if (!errorText && cliResult.error) errorText = cliResult.error;
        if (!errorText && cliResult.exitCode !== 0) {
          const cause = agentErrorSummary(cliResult.output || '');
          errorText = agentName + ' exited with code ' + cliResult.exitCode + (cause ? ': ' + cause : cliResult.output ? ': ' + cliResult.output.slice(-2000) : '');
        }
        if (!errorText && parsed && parsed.isError) errorText = parsed.result || agentName + ' reported an error.';
        if (!errorText) verification = await runVerifier(task, workspace, env);
      } catch (error) {
        errorText = error.message || String(error);
      }

      const elapsedMs = Date.now() - trialStarted;
      const changes = await workspaceChanges(task.repoDir, workspace).catch(() => null);
      const passed = !errorText && verification.exitCode === 0;
      trials.push({
        taskId: task.id,
        taskFingerprint: task.taskFingerprint,
        category: task.category,
        difficulty: task.difficulty,
        trial,
        status: passed ? 'passed' : 'failed',
        passed,
        model: parsed && parsed.model ? parsed.model : config.model || null,
        inputTokens: parsed ? parsed.inputTokens : null,
        outputTokens: parsed ? parsed.outputTokens : null,
        totalTokens: parsed ? parsed.totalTokens : null,
        costUSD: parsed ? parsed.costUSD : null,
        wallTimeMs: elapsedMs,
        cliVersion,
        finished: !errorText,
        toolCalls: parsed ? parsed.numTurns : null,
        verification: { exitCode: verification.exitCode, output: verification.output },
        changes,
        error: errorText
      });
      output.write((passed ? '  PASS ' : '  FAIL ') + task.id + ' trial ' + trial +
        ' · ' + (trials[trials.length - 1].totalTokens === null ? 'tokens n/a' : trials[trials.length - 1].totalTokens + ' tokens') +
        ' · ' + elapsedMs + ' ms' +
        (trials[trials.length - 1].costUSD === null ? ' · cost n/a' : ' · $' + trials[trials.length - 1].costUSD.toFixed(6)) +
        (errorText ? ' · ' + errorText.slice(0, 240) : '') + '\n');
      await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    }
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
  const observedModels = [...new Set(trials.map((item) => item.model).filter(Boolean))].sort();
  const modelLabel = config.model || (observedModels.length ? observedModels.join(', ') : 'model not reported by CLI');
  const summary = {
    label: agentName + ' ' + cliVersion + ' (' + modelLabel + ')',
    ...(await revisionFields(env)),
    runId: startedAt.replace(/[^a-zA-Z0-9-]/g, '-') + '-' + process.pid,
    startedAt,
    completedAt: new Date().toISOString(),
    taskCount: selectedDirs.length,
    taskIds: selectedDirs.map((dir) => path.basename(dir)),
    trialsPerTask: config.trials,
    timeoutSeconds: config.timeoutSeconds,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    passRate: trials.length ? passedCount / trials.length : 0,
    passed: passedCount,
    failed: trials.length - passedCount,
    medianTimeMs,
    totalCostUSD,
    costPerPassedTaskUSD,
    provider: {
      model: modelLabel,
      protocol: adapter.protocol,
      cliVersion,
      maxTurns: config.maxTurns,
      timeoutSeconds: config.timeoutSeconds,
      budgetUSD: config.budgetUSD
    },
    pricing: {
      note: 'Cost is taken only from ' + agentName + ' JSON usage metadata. If the CLI or sign-in method does not expose a per-run USD cost, costUSD remains null; this does not mean the run was free.'
    }
  };
  const resultPath = await saveResults(trials, summary, { env, resultsDir: options.resultsDir });
  output.write(agentName + ' eval result: ' + resultPath + '\n');
  output.write('Pass rate: ' + passedCount + '/' + trials.length + ' (' + Math.round(summary.passRate * 100) + '%)\n');
  output.write('Median time: ' + (summary.medianTimeMs === null ? 'n/a' : summary.medianTimeMs + ' ms') + '\n');
  output.write('Cost per passed trial: ' + (summary.costPerPassedTaskUSD === null ? 'n/a' : '$' + summary.costPerPassedTaskUSD.toFixed(6)) + '\n');
  return { ok: trials.every((item) => item.status === 'passed'), summary, resultsPath: resultPath, results: trials };
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
    output.write((result.ok ? '  PASS ' : '  FAIL ') + result.id + (result.category ? ' [' + result.category + '/' + (result.difficulty || 'unspecified') + ']' : '') + (result.error ? ': ' + result.error : '') + '\n');
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
    output.write('Usage:\n  oasis eval --validate\n  oasis eval --negative-control\n  oasis eval [--task ID] [--trials N] [--timeout-seconds N] [--route-easy-model ID --route-strong-model ID [--route-mode cascade]] --yes\n  oasis eval --claude-code [--task ID] [--trials N] [--model MODEL] [--max-turns N] [--timeout-seconds N] [--budget-usd USD] --yes\n  oasis eval --codex | --gemini-cli | --opencode | --aider [--task ID] [--trials N] [--model MODEL] [--timeout-seconds N] --yes\n  oasis eval --compare <run-a.json> <run-b.json> [--out comparison.json] [--html comparison.html]\n\n');
    output.write('Model evaluations execute coding agents in disposable copies. The verifier is external to the workspace, but this is not an OS-level sandbox. Review the task suite and only run with --yes in a controlled workspace. Claude Code mode requires the CLI and its authentication.\n');
    return { ok: true };
  }
  if (config.compare) return await compareEvalReports(config.compare, {
    output,
    jsonOutputPath: config.compareOutput,
    htmlOutputPath: config.compareHtml
  });

  if (config.claudeCode) return await runClaudeCodeEval(config, { ...options, env, tasksDir, output });

  if (config.negativeControl) {
    const control = await runEvalNegativeControl({ tasksDir, env, snapshotsDir: options.snapshotsDir });
    const pct = (control.passRate * 100).toFixed(2);
    output.write('Evaluation negative control: ' + (control.ok ? 'PASS' : 'FAIL') + '\n');
    output.write('Unchanged snapshots accepted: ' + control.noOpPasses + '/' + control.total + ' (' + pct + '%); required: below ' + (control.threshold * 100).toFixed(0) + '%.\n');
    if (!control.fixturesValid) {
      output.write('Fixture validation failed. The reference-patch checks or fixture structure must be repaired before this control can pass.\n');
      for (const result of control.results.filter((item) => !item.ok)) {
        output.write('  FAIL ' + result.id + ': ' + (result.error || 'invalid fixture') + '\n');
      }
    }
    return { ok: control.ok, negativeControl: control };
  }

  if (config.validate) {
    const report = await validateEvaluationSuite({ tasksDir, env, snapshotsDir: options.snapshotsDir });
    printValidation(report, output);
    return { ok: report.ok, report };
  }

  if (!options.autoApprove) throw new Error('Model evaluation executes edits and commands in disposable task copies. Review the evaluation suite, then explicitly run oasis eval --yes [--task ID] [--trials N]. OS-level sandboxing is not provided.');
  const allDirs = await listTaskDirectories(tasksDir);
  const wanted = config.task ? String(config.task).split(',') : null;
  const selectedDirs = wanted ? allDirs.filter((dir) => wanted.includes(path.basename(dir))) : allDirs;
  const missingTask = wanted && wanted.find((id) => !selectedDirs.some((dir) => path.basename(dir) === id));
  if (missingTask) throw new Error('No evaluation task named "' + missingTask + '" was found.');
  if (!selectedDirs.length) throw new Error('No evaluation tasks were found in ' + tasksDir);
  const provider = await loadConfig({ env });
  if (!provider.configured) throw new Error('Configure a model provider before running eval tasks.');
  const startedAt = new Date().toISOString();
  const inputRate = readPrice(env.OASIS_EVAL_INPUT_USD_PER_MILLION_TOKENS);
  const outputRate = readPrice(env.OASIS_EVAL_OUTPUT_USD_PER_MILLION_TOKENS);
  const trials = [];
  const originalConfigDir = process.env.OASIS_CONFIG_DIR;

  try {
    for (const dir of selectedDirs) {
      const task = await assertTaskShape(dir, options.snapshotsDir || DEFAULT_SNAPSHOTS_DIR);
      for (let trial = 1; trial <= config.trials; trial++) {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oasis-eval-run-'));
        const workspace = path.join(tempRoot, 'workspace');
        await copySnapshot(task.repoDir, workspace);
        const isolatedConfigDir = path.join(tempRoot, 'oasis-config');
        await mkdir(isolatedConfigDir, { recursive: true, mode: 0o700 });
        let session = null;
        let usage = { inputTokens: 0, outputTokens: 0 };
        let agentResult = null;
        const trace = [];
        const requestTokens = [];
        let errorText = null;
        let verification = { exitCode: 1, output: 'Agent did not complete.' };
        let timeoutController = null;
        let timeoutTimer = null;
        const taskTimeoutMs = Number.isFinite(options.taskTimeoutMs) && options.taskTimeoutMs > 0
          ? options.taskTimeoutMs
          : config.timeoutSeconds * 1000;
        const timeoutSeconds = Math.ceil(taskTimeoutMs / 1000);
        const timeoutMessage = 'Task exceeded the ' + timeoutSeconds + '-second task timeout.';
        const trialStarted = Date.now();

        try {
          process.env.OASIS_CONFIG_DIR = isolatedConfigDir;
          session = await createSession({ root: workspace, config: provider });
          if (config.routeEasyModel) {
            session.settings ||= {};
            session.settings.modelRouting = {
              enabled: true,
              ...(config.routeMode === 'cascade' ? { mode: 'cascade' } : {}),
              easyModel: config.routeEasyModel,
              strongModel: config.routeStrongModel || provider.model
            };
          }
          timeoutController = new AbortController();
          timeoutTimer = setTimeout(() => {
            timeoutController.abort();
            // Interrupt the session as well as the current provider request so MCP,
            // background, and other session-owned processes are asked to stop.
            if (session) closeSession(session);
          }, taskTimeoutMs);
          const agentRunner = options.agentRunner || runAgentTurn;
          agentResult = await agentRunner(session, task.taskText, {
            autoApprove: true,
            onToolResult: (event) => recordTraceStep(trace, event),
            env: evalAgentEnvironment(process.env),
            maxSteps: provider.maxSteps,
            signal: timeoutController.signal,
            // Streamed like interactive and headless runs, so a stalled provider
            // hits the header timeout and idle watchdog (OASIS_NO_STREAM=1 opts out).
            ...(process.env.OASIS_NO_STREAM !== '1' ? { onDelta: () => {} } : {}),
            // A cascade run must not pin "medium"/"hard" fixtures to the strong
            // model up front: escalation on evidence is what is being measured.
            ...(config.routeEasyModel && config.routeMode !== 'cascade' ? { routingHint: task.difficulty } : {}),
            onUsage: (entry) => {
              usage.inputTokens += Number(entry.inputTokens || 0);
              usage.outputTokens += Number(entry.outputTokens || 0);
              if (requestTokens.length < TRACE_LIMIT) requestTokens.push([Number(entry.inputTokens || 0), Number(entry.outputTokens || 0)]);
            }
          });
          if (timeoutController.signal.aborted) errorText = timeoutMessage;
        } catch (error) {
          errorText = timeoutController && timeoutController.signal.aborted
            ? timeoutMessage
            : error.message || String(error);
        } finally {
          if (timeoutTimer) clearTimeout(timeoutTimer);
          if (session) closeSession(session);
          if (originalConfigDir === undefined) delete process.env.OASIS_CONFIG_DIR;
          else process.env.OASIS_CONFIG_DIR = originalConfigDir;
        }

        if (!errorText && agentResult) verification = await runVerifier(task, workspace, env);
        const elapsedMs = Date.now() - trialStarted;
        const changes = await workspaceChanges(task.repoDir, workspace).catch(() => null);
        const totalTokens = usage.inputTokens + usage.outputTokens;
        const taskUsage = agentResult && agentResult.taskUsage && typeof agentResult.taskUsage === 'object'
          ? agentResult.taskUsage
          : null;
        const routed = agentResult && agentResult.modelRouting && typeof agentResult.modelRouting === 'object'
          ? agentResult.modelRouting
          : null;
        const model = routed && typeof routed.selectedModel === 'string' ? routed.selectedModel : provider.model;
        const routedCostKnown = Boolean(taskUsage && taskUsage.costKnown === true && typeof taskUsage.costUSD === 'number');
        // Use the explicit benchmark token rates for ordinary, single-model runs.
        // Per-model agent estimates are reserved for routed runs, where a single uniform rate is misleading.
        const rated = config.routeEasyModel
          ? (routedCostKnown ? taskUsage.costUSD : null)
          : costEstimate(usage.inputTokens, usage.outputTokens, inputRate, outputRate);
        // A cloud model reached through a localhost gateway (LiteLLM and the like)
        // is billed as that cloud model, not counted as a free local one.
        const gatewayCloud = !config.routeEasyModel && rated === null && isLoopbackProvider(provider) && cloudModelBehindGateway(model, provider);
        const gatewayCost = gatewayCloud ? estimateCostUsd(model, usage, { config: provider, env }) : null;
        // A model served on this machine has no per-token API charge (hardware and power are not counted).
        const localModel = !config.routeEasyModel && rated === null && !gatewayCloud && isLoopbackProvider(provider);
        const costUSD = localModel ? 0 : gatewayCloud ? gatewayCost : rated;
        const strongModelCostUSD = taskUsage && typeof taskUsage.strongModelCostUSD === 'number'
          ? taskUsage.strongModelCostUSD
          : null;
        const routingSavingsUSD = taskUsage && typeof taskUsage.savingsUSD === 'number'
          ? taskUsage.savingsUSD
          : null;
        const costSource = benchmarkCostSource({ routed: Boolean(config.routeEasyModel), routedCostKnown, localModel, gatewayCloud, costUSD, model });
        // The same rule as every other agent: the hidden verifier passed and the run
        // ended without an error or timeout. OASIS's own "verification incomplete"
        // signal is kept in the record (finished / unfinished) but does not change the score.
        const passed = !errorText && Boolean(agentResult) && verification.exitCode === 0;
        trials.push({
          taskId: task.id, taskFingerprint: task.taskFingerprint, category: task.category, difficulty: task.difficulty, trial,
          status: passed ? 'passed' : 'failed',
          model, requestedModel: provider.model, routeTier: routed && routed.tier || 'strong', escalation: routed && routed.escalation || null,
          routeReason: routed && routed.reason || null,
          strongModel: routed && routed.strongModel || config.routeStrongModel || provider.model,
          protocol: provider.protocol, baseURL: provider.baseURL,
          maxSteps: provider.maxSteps, maxOutputTokens: provider.maxOutputTokens ?? null,
          inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, totalTokens,
          costUSD, strongModelCostUSD, routingSavingsUSD, costSource,
          wallTimeMs: elapsedMs, finished: Boolean(agentResult && agentResult.finished),
          toolCalls: agentResult ? agentResult.toolCalls : 0,
          trace, requestTokens,
          verification: { exitCode: verification.exitCode, output: verification.output },
          changes,
          error: errorText,
          ...(agentResult && !agentResult.finished ? { unfinished: unfinishedReason(agentResult) } : {})
        });
        output.write((passed ? '  PASS ' : '  FAIL ') + task.id + ' trial ' + trial +
          ' · ' + (config.routeEasyModel ? (routed && routed.tier || 'strong') + '/' : '') + model + (routed && routed.escalation ? '→' + routed.escalation.to + ' (step ' + routed.escalation.step + ')' : '') +
          ' · ' + totalTokens + ' tokens · ' + elapsedMs + ' ms' +
          (costUSD === null ? ' · cost unknown' : ' · $' + costUSD.toFixed(6)) +
          (routingSavingsUSD === null || !config.routeEasyModel ? '' : ' · saved vs strong $' + routingSavingsUSD.toFixed(6)) + '\n');
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
    label: 'OASIS ' + oasisVersion() + ' (' + provider.model + ')',
    ...(await revisionFields(env)),
    runId: path.basename(startedAt).replace(/[^a-zA-Z0-9-]/g, '-') + '-' + process.pid,
    startedAt, completedAt: new Date().toISOString(),
    taskCount: selectedDirs.length, taskIds: selectedDirs.map((dir) => path.basename(dir)), trialsPerTask: config.trials,
    timeoutSeconds: config.timeoutSeconds,
    runtime: { node: process.version, platform: process.platform, arch: process.arch },
    passRate: trials.length ? passedCount / trials.length : 0,
    passed: passedCount, failed: trials.length - passedCount,
    medianTimeMs, totalCostUSD, costPerPassedTaskUSD,
    routing: config.routeEasyModel ? {
      enabled: true,
      easyModel: config.routeEasyModel,
      strongModel: config.routeStrongModel || provider.model,
      mode: config.routeMode,
      note: config.routeMode === 'cascade'
        ? 'Cascade: tasks start on the easy model (security-sensitive prompts excepted) and move to the strong model when the run gets stuck; difficulty labels are not used as hints.'
        : 'Fixture difficulty labels are routing hints; unlabeled requests use conservative prompt classification.'
    } : { enabled: false },
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

// The OASIS code an eval runs is the code loaded when this module was
// imported. Reading HEAD only at the end mislabelled a long run: commits made
// while it ran (a fix landed 6 minutes in) were reported as the tested code.
const LOADED_REVISION = detectSourceRevision(process.env).catch(() => null);

export async function revisionFields(env = process.env) {
  const loaded = await LOADED_REVISION;
  const now = await detectSourceRevision(env).catch(() => null);
  const explicit = /^[a-f0-9]{40}$/i.test(String(env.OASIS_SOURCE_REVISION || env.GITHUB_SHA || '').trim());
  const revision = explicit ? now : (loaded || now);
  return {
    sourceRevision: revision,
    ...(!explicit && loaded && now && loaded !== now ? { sourceRevisionAtEnd: now, sourceChangedDuringRun: true } : {})
  };
}

// Where a trial's cost figure came from. A loopback provider is usually a model on
// this machine, but a benchmark gateway on 127.0.0.1 can forward a free-tier cloud
// model (an OpenRouter-style `:free` id); that is labelled as free tier, not local.
export function benchmarkCostSource({ routed = false, routedCostKnown = false, localModel = false, gatewayCloud = false, costUSD = null, model = '' } = {}) {
  if (routed) return routedCostKnown ? 'per-model pricing estimate' : 'unknown: configure pricing for both routed models';
  if (localModel && /:free$/i.test(String(model || ''))) return 'free-tier cloud model (":free" id) behind a localhost gateway: no per-token charge';
  if (localModel) return 'local model: no per-token API charge (hardware and power not counted)';
  if (gatewayCloud) return 'per-model list-price estimate (cloud model behind a localhost gateway; free-tier keys are not billed)';
  if (costUSD === null) return 'unknown: set OASIS_EVAL_*_USD_PER_MILLION_TOKENS';
  return 'uniform benchmark token-rate estimate';
}
