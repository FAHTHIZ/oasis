// Check memory: what a check showed on exactly these files, across sessions.
//
// The evidence ledger (src/evidence-ledger.mjs) knows what a check showed in
// this session, and forgets it when the session ends. The next session on the
// same files starts blind and reruns the suite to learn what was already
// known. Check memory keeps each finished check's outcome keyed by a
// fingerprint of the working tree: the commit's tree plus the content of
// every uncommitted, untracked (not ignored) file. Two uses:
//
//   - Known results. At the start of a session, checks already run on the
//     exact same files in earlier sessions are listed, with when and how
//     they ended. Any edit changes the fingerprint, so a stale result is
//     never offered as current.
//   - Divergence. When a check ends differently from an earlier run on the
//     same fingerprint (it passed on these files, now it fails), the files
//     cannot be the cause. The result says so: the check is flaky, or it
//     depends on something outside the tracked files (installed dependencies,
//     ignored files such as .env, services, the clock, the machine).
//
// Records live in the user's OASIS directory, never in the repository. The
// command line is stored with secrets redacted. Outside Git, or when the
// tree is too large to fingerprint quickly, nothing is recorded.
// OASIS_CHECK_MEMORY=0 or `"checkMemory": false` turns it off.

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { redactSecretText } from './secret-shield.mjs';

const MAX_RECORDS = 300;
const MAX_DIRTY = 2000;
const MAX_HASH_BYTES = 8 * 1024 * 1024;
const BUDGET_MS = 3000;
const NOTE_LIMIT = 6;

export function checkMemoryEnabled(settings = {}, env = process.env) {
  if (/^(?:0|false|off|no)$/i.test(String(env.OASIS_CHECK_MEMORY || ''))) return false;
  return !(settings && settings.checkMemory === false);
}

function git(args, cwd, timeout) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 32 * 1024 * 1024, encoding: 'buffer', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }, (error, stdout) => resolve(error ? null : stdout));
  });
}

async function fileDigest(file) {
  try {
    const info = await stat(file);
    if (info.isDirectory()) return 'dir';
    if (info.size > MAX_HASH_BYTES) return 'large:' + info.size + ':' + Math.floor(info.mtimeMs);
    return createHash('sha256').update(await readFile(file)).digest('hex');
  } catch { return 'missing'; }
}

/**
 * The working tree's fingerprint: { id, top, tree, dirty } or null outside Git
 * or past the time budget. Read-only: nothing is written to the repository.
 */
export async function workspaceFingerprint(root, { budgetMs = BUDGET_MS } = {}) {
  if (!root) return null;
  const started = Date.now();
  const topRaw = await git(['rev-parse', '--show-toplevel'], root, budgetMs);
  if (!topRaw) return null;
  const top = topRaw.toString('utf8').trim();
  const treeRaw = await git(['rev-parse', '--verify', '--quiet', 'HEAD^{tree}'], top, budgetMs);
  const tree = treeRaw ? treeRaw.toString('utf8').trim() : 'unborn';
  const statusRaw = await git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--no-renames'], top, Math.max(200, budgetMs - (Date.now() - started)));
  if (!statusRaw) return null;
  const paths = [];
  for (const entry of statusRaw.toString('utf8').split('\0')) if (entry.length > 3) paths.push(entry.slice(3));
  if (paths.length > MAX_DIRTY) return null;
  paths.sort();
  const hash = createHash('sha256').update('oasis-check-memory/1\0' + tree + '\0');
  for (const file of paths) {
    if (Date.now() - started > budgetMs) return null;
    hash.update(file + '\0' + await fileDigest(path.join(top, file)) + '\0');
  }
  return { id: hash.digest('hex').slice(0, 24), top, tree, dirty: paths.length };
}

export function storePath(top, env = process.env) {
  const key = createHash('sha256').update(path.resolve(top)).digest('hex').slice(0, 20);
  return path.join(getConfigDirectory(env), 'check-memory', key + '.json');
}

async function loadStore(file) {
  try {
    const data = JSON.parse(await readFile(file, 'utf8'));
    return data && Array.isArray(data.records) ? data : { version: 1, records: [] };
  } catch { return { version: 1, records: [] }; }
}

async function saveStore(file, data) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + Date.now() + '.tmp';
  await writeFile(temp, JSON.stringify(data), { mode: 0o600 });
  await rename(temp, file);
}

function keyOf(command, cwd) { return String(cwd || '.') + '\0' + String(command || ''); }

/** A check event the memory can stand on: finished, unmasked, unfiltered, ran tests, changed nothing. */
export function rememberable(event) {
  return Boolean(event) && event.kind === 'check' && event.finished === true && typeof event.passed === 'boolean'
    && !event.masked && !event.filtered && !event.noTests && !(Array.isArray(event.changed) && event.changed.length);
}

/**
 * Records a finished check against the current fingerprint. Returns
 * { fingerprint, divergence } where divergence is the earlier record on the
 * same files that ended the other way, or null.
 */
export async function recordCheck(root, event, { env = process.env, settings = {}, sessionId = '', cwd = '.', now = Date.now(), fingerprint = null } = {}) {
  if (!checkMemoryEnabled(settings, env) || !rememberable(event)) return null;
  const print = fingerprint || await workspaceFingerprint(root);
  if (!print) return null;
  const file = storePath(print.top, env);
  const store = await loadStore(file);
  const command = redactSecretText(String(event.command || '')).slice(0, 300);
  const relCwd = path.relative(print.top, path.resolve(root, cwd || '.')) || '.';
  const key = keyOf(command, relCwd);
  const earlier = store.records.filter((record) => record.fingerprint === print.id && keyOf(record.command, record.cwd) === key);
  const divergence = earlier.filter((record) => record.passed !== event.passed).sort((a, b) => b.at - a.at)[0] || null;
  const previous = earlier.sort((a, b) => b.at - a.at)[0];
  const outcomes = { pass: (previous && previous.outcomes && previous.outcomes.pass) || 0, fail: (previous && previous.outcomes && previous.outcomes.fail) || 0 };
  outcomes[event.passed ? 'pass' : 'fail'] += 1;
  store.records = store.records.filter((record) => !(record.fingerprint === print.id && keyOf(record.command, record.cwd) === key));
  store.records.push({ command, cwd: relCwd, checkKind: event.checkKind || 'test', fingerprint: print.id, tree: print.tree, dirty: print.dirty, passed: event.passed, exitCode: event.exitCode, at: now, sessionId: String(sessionId || ''), outcomes });
  if (store.records.length > MAX_RECORDS) store.records.splice(0, store.records.length - MAX_RECORDS);
  store.version = 1;
  store.root = print.top;
  try { await saveStore(file, store); } catch { return { fingerprint: print, divergence }; }
  return { fingerprint: print, divergence };
}

function ago(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return minutes + ' minute' + (minutes === 1 ? '' : 's') + ' ago';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
  return Math.round(hours / 24) + ' days ago';
}

/** The note added to a check result that ended differently on the same files. */
export function divergenceNote(event, divergence, now = Date.now()) {
  if (!divergence) return '';
  return '[OASIS check memory] This check ' + (divergence.passed ? 'passed' : 'failed') + ' on exactly these files ' + ago(now - divergence.at)
    + ' (same commit, same uncommitted and untracked files), and now ' + (event.passed ? 'passed' : 'failed')
    + '. The tracked files did not cause the difference: the check is flaky, or it depends on something outside them (installed dependencies, ignored files such as .env, a service, the clock or the machine). Look there before changing code.';
}

/**
 * Checks run on exactly the current files in earlier sessions, as a note for
 * the first turn, or '' when there are none.
 */
export async function knownChecksNote(root, { env = process.env, settings = {}, sessionId = '', now = Date.now(), fingerprint = null } = {}) {
  if (!checkMemoryEnabled(settings, env)) return '';
  const print = fingerprint || await workspaceFingerprint(root);
  if (!print) return '';
  const store = await loadStore(storePath(print.top, env));
  const known = store.records.filter((record) => record.fingerprint === print.id && (!sessionId || record.sessionId !== String(sessionId)))
    .sort((a, b) => b.at - a.at).slice(0, NOTE_LIMIT);
  if (!known.length) return '';
  const lines = known.map((record) => {
    const runs = record.outcomes && record.outcomes.pass && record.outcomes.fail
      ? 'gave different results on these files (' + record.outcomes.pass + ' passed, ' + record.outcomes.fail + ' failed); last ' + (record.passed ? 'passed' : 'failed (exit ' + record.exitCode + ')')
      : record.passed ? 'passed' : 'failed (exit ' + record.exitCode + ')';
    return '- `' + record.command + '`' + (record.cwd && record.cwd !== '.' ? ' in ' + record.cwd : '') + ': ' + runs + ', ' + ago(now - record.at);
  });
  return '[OASIS check memory] These checks already ran on exactly the current files (same commit, same uncommitted and untracked files) in earlier sessions:\n'
    + lines.join('\n')
    + '\nYou need not rerun one just to learn its result, unless something outside the tracked files may have changed (dependencies, environment, services). Any edit makes these results stale, and they are not offered again.';
}
