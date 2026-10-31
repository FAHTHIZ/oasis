import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { processTreeSpawnOptions, signalProcessTree } from './process-tree.mjs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, getConfigDirectory } from './config.mjs';
import { createSession, runAgentTurn, closeSession } from './agent.mjs';
import { renderComparisonHtml, saveComparisonArtifact } from './eval-report.mjs';

const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TASKS_DIR = path.join(APP_ROOT, 'evals', 'tasks');
const DEFAULT_SNAPSHOTS_DIR = path.join(APP_ROOT, 'evals', 'snapshots');
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
export async function runEvalNegativeControl(options = {}) {
  const report = await validateEvaluationSuite(options);
  const noOpPasses = report.results.filter((result) => result.noOpExitCode === 0).length;
  const total = report.total;
  const passRate = total > 0 ? noOpPasses / total : 1;
  const threshold = 0.10;
  const ok = report.ok && passRate < threshold;
  return {
    ok,
    total,
    noOpPasses,
    passRate,
    threshold,
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
    if (!leftFingerprint || !rightFingerprint) unverifiedFingerprints.push(taskId);
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
    'Task fingerprints: ' + taskRows.filter((row) => row.fingerprintStatus === 'verified').length + '/' + taskRows.length + ' verified; ' + mismatchedFingerprints.length + ' fingerprint-mismatched task(s) excluded; ' + mismatchedMetadata.length + ' metadata-mismatched task(s) excluded; ' + unverifiedFingerprints.length + ' legacy/unfingerprinted task(s) compared by ID only.',
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
    timeoutExplicit: false, budgetUSD: null, claudeOptionsUsed: false
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
    if (arg === '--claude-code') { config.claudeCode = true; continue; }
    if (arg === '--model') {
      if (!args[i + 1] || args[i + 1].startsWith('-')) throw new Error('--model requires a Claude Code model name or alias.');
      config.model = args[++i];
      config.claudeOptionsUsed = true;
      continue;
    }
    if (arg === '--max-turns') {
      const value = Number(args[++i]);
      if (!Number.isInteger(value) || value < 1 || value > 200) throw new Error('--max-turns must be an integer from 1 to 200.');
      config.maxTurns = value;
      config.claudeOptionsUsed = true;
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
  if (config.task && !safeId(config.task)) throw new Error('Task IDs may contain lowercase letters, numbers, and hyphens.');
  if ((config.compareOutput || config.compareHtml) && !config.compare) {
    throw new Error('--out and --html are only valid with --compare.');
  }
  if (config.compareOutput && config.compareHtml && path.resolve(config.compareOutput) === path.resolve(config.compareHtml)) {
    throw new Error('JSON and HTML comparison outputs must use different paths.');
  }
  if (config.claudeOptionsUsed && !config.claudeCode) {
    throw new Error('--model, --max-turns and --budget-usd require --claude-code.');
  }
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
  const costUSD = finiteMetric(payload.total_cost_usd, payload.totalCostUSD, payload.costUSD, payload.cost_usd,
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

export function buildClaudeCodeArgs(config, prompt) {
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

function versionSupportsRestrictedMode(versionText) {
  const match = String(versionText || '').match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) return false;
  const [major, minor, patch] = match.slice(1).map(Number);
  return major > 2 || (major === 2 && minor > 1) || (major === 2 && minor === 1 && patch >= 248);
}

async function runClaudeCodeEval(config, options = {}) {
  const output = options.output || process.stdout;
  if (!options.autoApprove) {
    throw new Error('Claude Code evaluation runs an external coding agent against disposable task copies. Review the task suite, then explicitly run oasis eval --claude-code --yes [--task ID] [--trials N].');
  }
  const env = options.env || process.env;
  const tasksDir = options.tasksDir || DEFAULT_TASKS_DIR;
  const allDirs = await listTaskDirectories(tasksDir);
  const selectedDirs = config.task ? allDirs.filter((dir) => path.basename(dir) === config.task) : allDirs;
  if (!selectedDirs.length) throw new Error(config.task ? 'No evaluation task named "' + config.task + '" was found.' : 'No evaluation tasks were found in ' + tasksDir);

  const command = String(env.OASIS_CLAUDE_CODE_BIN || 'claude');
  const runCli = options.claudeRunner || ((args, runnerOptions) => runEvalProcess(command, args, runnerOptions));
  const versionResult = await runCli(['--version'], {
    cwd: APP_ROOT, env, timeoutMs: 15000, outputLimit: 20000
  });
  if (versionResult.exitCode !== 0 || versionResult.timedOut || versionResult.error) {
    throw new Error('Could not start the Claude Code CLI (' + command + '). Install Claude Code, ensure it is on PATH, and sign in. ' +
      (versionResult.error || versionResult.output || 'CLI version check failed.'));
  }
  const cliVersion = String(versionResult.stdout || '').trim().split(/\r?\n/).slice(0, 2).join(' ').slice(0, 120);
  if (!versionSupportsRestrictedMode(cliVersion)) {
    throw new Error('Claude Code ' + (cliVersion || '(unknown version)') + ' is too old or unrecognized. This benchmark requires Claude Code v2.1.248 or newer for restricted mode.');
  }

  const startedAt = new Date().toISOString();
  const trials = [];
  for (const dir of selectedDirs) {
    const task = await assertTaskShape(dir, options.snapshotsDir || DEFAULT_SNAPSHOTS_DIR);
    for (let trial = 1; trial <= config.trials; trial++) {
      const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'oasis-claude-eval-'));
      const workspace = path.join(tempRoot, 'workspace');
      const trialStarted = Date.now();
      let errorText = null;
      let cliResult = null;
      let parsed = null;
      let verification = { exitCode: 1, output: 'Agent did not complete.' };
      try {
        await copySnapshot(task.repoDir, workspace);
        const prompt = task.taskText.trim() + '\n\nBenchmark constraints: solve this task using only the current workspace. Do not access files outside this workspace, use the network, change the task harness, or bypass verification. The harness runs the task verifier independently after you finish.';
        cliResult = await runCli(buildClaudeCodeArgs(config, prompt), {
          cwd: workspace,
          env,
          timeoutMs: config.timeoutSeconds * 1000,
          outputLimit: 1024 * 1024
        });
        try {
          parsed = parseClaudeCodeOutput(cliResult.stdout);
        } catch (error) {
          errorText = error.message || String(error);
        }
        if (!errorText && cliResult.timedOut) errorText = 'Claude Code exceeded the ' + config.timeoutSeconds + '-second task timeout.';
        if (!errorText && cliResult.error) errorText = cliResult.error;
        if (!errorText && cliResult.exitCode !== 0) {
          errorText = 'Claude Code exited with code ' + cliResult.exitCode + (cliResult.output ? ': ' + cliResult.output.slice(-2000) : '');
        }
        if (!errorText && parsed && parsed.isError) errorText = parsed.result || 'Claude Code reported an error.';
        if (!errorText) verification = await runVerifier(task, workspace, env);
      } catch (error) {
        errorText = error.message || String(error);
      }

      const elapsedMs = Date.now() - trialStarted;
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
    label: 'Claude Code ' + cliVersion + ' (' + modelLabel + ')',
    sourceRevision: await detectSourceRevision(env),
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
      protocol: 'claude-code-cli',
      cliVersion,
      maxTurns: config.maxTurns,
      timeoutSeconds: config.timeoutSeconds,
      budgetUSD: config.budgetUSD
    },
    pricing: {
      note: 'Cost is taken only from Claude Code CLI JSON usage metadata. If the CLI or sign-in method does not expose a per-run USD cost, costUSD remains null; this does not mean the run was free.'
    }
  };
  const resultPath = await saveResults(trials, summary, { env, resultsDir: options.resultsDir });
  output.write('Claude Code eval result: ' + resultPath + '\n');
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
    output.write('Usage:\n  oasis eval --validate\n  oasis eval --negative-control\n  oasis eval [--task ID] [--trials N] [--timeout-seconds N] --yes\n  oasis eval --claude-code [--task ID] [--trials N] [--model MODEL] [--max-turns N] [--timeout-seconds N] [--budget-usd USD] --yes\n  oasis eval --compare <run-a.json> <run-b.json> [--out comparison.json] [--html comparison.html]\n\n');
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
    output.write('Evaluation negative control: ' + (control.ok ? 'PASS' : 'FAIL') + '\\n');
    output.write('Unchanged snapshots accepted: ' + control.noOpPasses + '/' + control.total + ' (' + pct + '%); required: below ' + (control.threshold * 100).toFixed(0) + '%.\\n');
    if (!control.fixturesValid) {
      output.write('Fixture validation failed. The reference-patch checks or fixture structure must be repaired before this control can pass.\\n');
      for (const result of control.results.filter((item) => !item.ok)) {
        output.write('  FAIL ' + result.id + ': ' + (result.error || 'invalid fixture') + '\\n');
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
            env: process.env,
            maxSteps: provider.maxSteps,
            signal: timeoutController.signal,
            onUsage: (entry) => {
              usage.inputTokens += Number(entry.inputTokens || 0);
              usage.outputTokens += Number(entry.outputTokens || 0);
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
        const totalTokens = usage.inputTokens + usage.outputTokens;
        const costUSD = costEstimate(usage.inputTokens, usage.outputTokens, inputRate, outputRate);
        const passed = !errorText && Boolean(agentResult && agentResult.finished) && verification.exitCode === 0;
        trials.push({
          taskId: task.id, taskFingerprint: task.taskFingerprint, category: task.category, difficulty: task.difficulty, trial,
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
    sourceRevision: await detectSourceRevision(env),
    runId: path.basename(startedAt).replace(/[^a-zA-Z0-9-]/g, '-') + '-' + process.pid,
    startedAt, completedAt: new Date().toISOString(),
    taskCount: selectedDirs.length, taskIds: selectedDirs.map((dir) => path.basename(dir)), trialsPerTask: config.trials,
    timeoutSeconds: config.timeoutSeconds,
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
