// Command rehearsal (docs/REHEARSAL.md).
//
// Before a command that needs approval runs, it can run once in a throwaway
// copy-on-write view of the workspace. bubblewrap mounts an overlay on the
// workspace path: the real workspace is the read-only lower layer, a private
// directory is the upper layer, and every write the command makes lands in
// the upper layer. The rest of the file system is read-only, /tmp is a fresh
// tmpfs, the network and PID namespaces are private and, where the seccomp
// helper exists, Unix sockets cannot be opened. When the command exits, the
// upper layer is the exact set of changes it made:
//
//   regular file or symlink  created, or modified when the lower one differs
//   character device 0/0     a whiteout: the path was deleted
//   directory                created, or (if it replaced a lower directory)
//                            the names missing from the merged listing were
//                            deleted; a helper lists merged directories from
//                            inside the sandbox, so opaque directories need no
//                            extended-attribute support on the host
//
// The approval prompt then says what the command would do, measured rather
// than predicted. The rehearsal can also be applied: its upper layer is copied
// into the workspace after checking that none of the touched paths changed
// since, so what was approved is exactly what lands (no second run that might
// behave differently). Without bubblewrap overlay support (macOS, Windows,
// bubblewrap < 0.11, kernels without unprivileged overlayfs) rehearsal reports
// itself unavailable and nothing changes.

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectSensitivePaths, tmpToolchainMounts, unixSocketFilterPath } from './sandbox.mjs';

export const REHEARSAL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT = 64 * 1024;
const MAX_LISTED = 200;
const LISTER = fileURLToPath(new URL('./rehearsal-lister.mjs', import.meta.url));

let probed;
/** Whether this host can rehearse: Linux, bubblewrap with --overlay, unprivileged overlayfs. */
export function rehearsalSupport() {
  if (probed) return probed;
  if (process.platform !== 'linux') return (probed = { available: false, reason: 'Rehearsal needs Linux with bubblewrap; this is ' + process.platform + '.' });
  let base = '';
  try {
    base = path.join(os.tmpdir(), 'oasis-rehearsal-probe-' + process.pid + '-' + Date.now());
    for (const dir of ['lower', 'up', 'work']) mkdirSync(path.join(base, dir), { recursive: true });
    const result = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--overlay-src', path.join(base, 'lower'), '--overlay', path.join(base, 'up'), path.join(base, 'work'), path.join(base, 'lower'), '--unshare-net', '--unshare-pid', '--die-with-parent', '--', '/bin/sh', '-c', 'echo x > ' + JSON.stringify(path.join(base, 'lower', 'f'))], { timeout: 5000, encoding: 'utf8' });
    if (result.error) probed = { available: false, reason: 'bubblewrap (bwrap) is not installed.' };
    else if (result.status !== 0) probed = { available: false, reason: 'bubblewrap cannot mount an overlay here (needs bubblewrap 0.11+ and unprivileged overlayfs): ' + String(result.stderr || '').trim().slice(0, 200) };
    else probed = { available: true, reason: '' };
  } catch (error) {
    probed = { available: false, reason: String(error && error.message || error) };
  } finally {
    if (base) rmSync(base, { recursive: true, force: true });
  }
  return probed;
}

/** For tests. */
export function resetRehearsalProbe() { probed = undefined; }

/** OASIS_REHEARSE=1 (or settings.rehearse === true) rehearses commands before asking for approval. */
export function rehearsalEnabled(env = process.env, settings = {}, sandbox = null) {
  const value = String(env.OASIS_REHEARSE ?? '').trim().toLowerCase();
  if (['0', 'false', 'off', 'no'].includes(value)) return false;
  if (['1', 'true', 'on', 'yes', 'auto'].includes(value)) return true;
  if (settings && typeof settings.rehearse === 'boolean') return settings.rehearse;
  // Unset: on when the bubblewrap sandbox is already in use. Those users accepted bwrap,
  // and under it the only commands still prompting are the high-risk ones, where seeing
  // the exact file changes matters most.
  return Boolean(sandbox && sandbox.available && sandbox.kind === 'bubblewrap');
}

function refuseRoot(root) {
  const resolved = path.resolve(root);
  if (resolved === path.parse(resolved).root) return 'refusing to rehearse with the file system root as the workspace';
  if (resolved === path.resolve(os.homedir())) return 'refusing to rehearse with the home directory as the workspace';
  return '';
}

function tail(text) {
  const value = String(text || '');
  return value.length > MAX_OUTPUT ? value.slice(-MAX_OUTPUT) : value;
}

/**
 * Run `command args` once against an overlay of `root`. Nothing in `root` changes.
 * Returns { status: 'ok'|'failed'|'timeout'|'unavailable'|'error', exitCode, stdout, stderr,
 * changes: { created, modified, deleted, touched }, git, readOnlyWrites, ms, keep }.
 * Call disposeRehearsal(result) when done, or applyRehearsal(result) to keep its changes.
 */
// Git settings passed in the environment (GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n) can carry
// credentials: a proxy URL with a password, an Authorization header, a token in an
// insteadOf URL. An unapproved rehearsal has no network to use them on, but could write
// them into file names the model sees, so those entries are neutralised.
const CREDENTIAL_VALUE = /:\/\/[^/\s@]+@|\bauthorization\s*:|\bbearer\s+\S|\b(?:token|password|secret)\s*[=:]/i;
export function withoutGitConfigCredentials(env) {
  const out = { ...env };
  const count = /^\d{1,3}$/.test(String(out.GIT_CONFIG_COUNT || '')) ? Number(out.GIT_CONFIG_COUNT) : 0;
  for (let i = 0; i < count; i++) {
    const key = 'GIT_CONFIG_KEY_' + i;
    const value = 'GIT_CONFIG_VALUE_' + i;
    if (CREDENTIAL_VALUE.test(String(out[value] || '')) || CREDENTIAL_VALUE.test(String(out[key] || '')) || /extraheader$/i.test(String(out[key] || ''))) { out[key] = 'oasis.rehearsalRedacted'; out[value] = ''; }
  }
  return out;
}

export async function rehearseCommand({ root, command, args = [], env = process.env, timeoutMs = REHEARSAL_TIMEOUT_MS, cwd = root, network = false, masked = [] } = {}) {
  const started = Date.now();
  const support = rehearsalSupport();
  if (!support.available) return { status: 'unavailable', reason: support.reason, changes: emptyChanges(), ms: 0 };
  const refused = refuseRoot(root);
  if (refused) return { status: 'unavailable', reason: refused, changes: emptyChanges(), ms: 0 };
  const lower = path.resolve(root);
  const state = await mkdtemp(path.join(os.tmpdir(), 'oasis-rehearsal-'));
  // overlayfs is undefined when the upper layer sits inside the lower one (or the reverse).
  if (pathContains(lower, state) || pathContains(state, lower)) {
    await rm(state, { recursive: true, force: true });
    return { status: 'unavailable', reason: 'the temporary directory is inside the workspace; set TMPDIR elsewhere to rehearse', changes: emptyChanges(), ms: 0 };
  }
  const upper = path.join(state, 'up');
  const work = path.join(state, 'work');
  const report = path.join(state, 'report');
  await Promise.all([mkdir(upper), mkdir(work), mkdir(report)]);
  const filter = unixSocketFilterPath();
  const bwrapArgs = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp'];
  // Host daemons reached over sockets under /run would act outside the overlay.
  for (const dir of ['/run', '/var/run', '/dev/shm', env.XDG_RUNTIME_DIR || '']) {
    if (dir && !pathContains(dir, lower) && await isDir(dir)) bwrapArgs.push('--tmpfs', dir);
  }
  // The command has not been approved yet, and the names of the files it
  // creates are shown to the model. It gets the same view as a real sandboxed
  // run: credential folders and files (~/.ssh, ~/.aws, OASIS's own config and
  // the rest of the sandbox's list) are hidden, and secret environment
  // variables are removed below. Without this, a command could read a key and
  // put it in a file name before anyone approved it.
  for (const item of collectSensitivePaths(env)) {
    if (pathContains(item.path, lower) || pathContains(lower, item.path) || pathContains('/tmp', item.path)) continue;
    if (item.type === 'directory') bwrapArgs.push('--tmpfs', item.path);
    else bwrapArgs.push('--ro-bind', '/dev/null', item.path);
  }
  // Toolchains installed under /tmp (and this Node binary) stay visible over the fresh /tmp.
  for (const dir of new Set([...tmpToolchainMounts(command, env), ...tmpToolchainMounts(process.execPath, env)])) {
    if (!pathContains(dir, lower) && !pathContains(lower, dir)) bwrapArgs.push('--ro-bind', dir, dir);
  }
  // The active sandbox's own masks too (its denyRead entries), when the caller passes them.
  for (const item of masked) {
    if (!item || typeof item.path !== 'string' || pathContains('/tmp', item.path) || pathContains(lower, item.path) || pathContains(item.path, lower) || pathContains(state, item.path)) continue;
    if (item.type === 'directory') bwrapArgs.push('--tmpfs', item.path);
    else if (item.type === 'file') bwrapArgs.push('--ro-bind', '/dev/null', item.path);
  }
  bwrapArgs.push('--overlay-src', lower, '--overlay', upper, work, lower);
  bwrapArgs.push('--ro-bind', upper, upper, '--bind', report, report, '--ro-bind', LISTER, LISTER);
  if (filter) bwrapArgs.push('--ro-bind', filter, filter);
  bwrapArgs.push('--unshare-pid', '--unshare-ipc', '--unshare-uts', '--die-with-parent', '--new-session');
  if (!network) bwrapArgs.push('--unshare-net');
  bwrapArgs.push('--chdir', path.resolve(cwd), '--', process.execPath, LISTER, upper, lower, path.join(report, 'merged.json'), '--', ...(filter ? [filter] : []), command, ...args);
  const { scrubEnvironment } = await import('./tools.mjs');
  const child = spawn('bwrap', bwrapArgs, { env: { ...withoutGitConfigCredentials(scrubEnvironment(env)), OASIS_REHEARSAL: '1', ...(network ? {} : { OASIS_REHEARSAL_RECORD_NET: '1' }) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout = tail(stdout + chunk); });
  child.stderr.on('data', (chunk) => { stderr = tail(stderr + chunk); });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, Math.max(1000, timeoutMs));
  const exitCode = await new Promise((resolve) => {
    child.on('error', (error) => { stderr += String(error.message || error); resolve(null); });
    child.on('close', (code) => resolve(code));
  });
  clearTimeout(timer);
  let merged = {};
  let commandExit = exitCode;
  let reported = false;
  let contacts = [];
  try {
    const parsed = JSON.parse(await readFile(path.join(report, 'merged.json'), 'utf8'));
    merged = parsed.dirs || {};
    if (Array.isArray(parsed.contacts)) contacts = parsed.contacts.filter((item) => item && typeof item.host === 'string' && /^[a-z0-9.:_-]{1,253}$/.test(item.host)).slice(0, 20).map((item) => ({ host: item.host, port: Number(item.port) || 0 }));
    if (Number.isInteger(parsed.exitCode)) commandExit = parsed.exitCode;
    reported = true;
  } catch {}
  let changes;
  try { changes = await collectChanges(upper, lower, merged); } catch (error) { changes = { ...emptyChanges(), error: String(error.message || error) }; }
  const result = {
    status: timedOut ? 'timeout' : !reported ? 'error' : commandExit === 0 ? 'ok' : 'failed',
    exitCode: timedOut ? null : commandExit,
    stdout, stderr,
    changes: changes.public,
    git: changes.git,
    readOnlyWrites: /read-only file system/i.test(stderr),
    network: Boolean(network),
    contacts,
    ms: Date.now() - started,
    keep: { state, upper, lower, entries: changes.entries, digests: changes.digests }
  };
  return result;
}

function emptyChanges() { return { created: [], modified: [], deleted: [], touched: [] }; }

async function isDir(dir) { try { return (await lstat(dir)).isDirectory(); } catch { return false; } }

function pathContains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function digestOf(file) {
  let info;
  try { info = await lstat(file); } catch { return 'absent'; }
  if (info.isSymbolicLink()) return 'link:' + await readlink(file);
  if (info.isDirectory()) return 'dir';
  if (!info.isFile()) return 'special';
  return 'file:' + (info.mode & 0o777).toString(8) + ':' + createHash('sha256').update(await readFile(file)).digest('hex');
}

async function lowerFiles(dir, rel, out) {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const childRel = rel ? rel + '/' + entry.name : entry.name;
    if (entry.isDirectory()) await lowerFiles(path.join(dir, entry.name), childRel, out);
    else out.push(childRel);
  }
}

// Walk the upper layer and classify every path against the lower layer.
async function collectChanges(upper, lower, merged) {
  const created = new Set();
  const modified = new Set();
  const deleted = new Set();
  const touched = new Set();
  const entries = [];
  const walk = async (rel) => {
    const dir = rel ? path.join(upper, rel) : upper;
    const items = await readdir(dir, { withFileTypes: true });
    if (rel) {
      const lowerDir = path.join(lower, rel);
      if (await isDir(lowerDir) && Array.isArray(merged[rel])) {
        const present = new Set(merged[rel]);
        for (const name of await readdir(lowerDir)) {
          if (present.has(name)) continue;
          const lowerPath = path.join(lowerDir, name);
          const childRel = rel + '/' + name;
          if (await isDir(lowerPath)) { const files = []; await lowerFiles(lowerPath, childRel, files); files.forEach((file) => deleted.add(file)); }
          else deleted.add(childRel);
          entries.push({ rel: childRel, kind: 'delete' });
        }
      }
    }
    for (const item of items) {
      const childRel = rel ? rel + '/' + item.name : item.name;
      const upperPath = path.join(upper, childRel);
      const lowerPath = path.join(lower, childRel);
      const info = await lstat(upperPath);
      let lowerInfo = null;
      try { lowerInfo = await lstat(lowerPath); } catch {}
      if (info.isCharacterDevice() && info.rdev === 0) {
        if (lowerInfo && lowerInfo.isDirectory()) { const files = []; await lowerFiles(lowerPath, childRel, files); files.forEach((file) => deleted.add(file)); }
        else if (lowerInfo) deleted.add(childRel);
        entries.push({ rel: childRel, kind: 'delete' });
        continue;
      }
      if (lowerInfo && lowerInfo.isDirectory() && !info.isDirectory()) {
        const files = []; await lowerFiles(lowerPath, childRel, files); files.forEach((file) => deleted.add(file));
        entries.push({ rel: childRel, kind: 'delete' });
        lowerInfo = null;
      }
      if (info.isDirectory()) {
        if (lowerInfo && !lowerInfo.isDirectory()) { deleted.add(childRel); entries.push({ rel: childRel, kind: 'delete' }); }
        entries.push({ rel: childRel, kind: 'dir', mode: info.mode & 0o7777 });
        await walk(childRel);
        continue;
      }
      if (info.isSymbolicLink()) entries.push({ rel: childRel, kind: 'link', target: await readlink(upperPath) });
      else if (info.isFile()) entries.push({ rel: childRel, kind: 'file', mode: info.mode & 0o7777 });
      else continue;
      if (!lowerInfo) { created.add(childRel); continue; }
      const [before, after] = await Promise.all([digestOf(lowerPath), digestOf(upperPath)]);
      if (before === after) touched.add(childRel);
      else modified.add(childRel);
      deleted.delete(childRel);
    }
  };
  await walk('');
  for (const file of created) deleted.delete(file);
  for (const file of modified) deleted.delete(file);
  const isGit = (rel) => rel === '.git' || rel.startsWith('.git/');
  const git = [...created, ...modified, ...deleted].filter(isGit).length;
  const pick = (set) => [...set].filter((rel) => !isGit(rel)).sort();
  // Record the lower state of every touched path so applying can detect later changes.
  const digests = {};
  for (const rel of new Set([...created, ...modified, ...deleted, ...touched, ...entries.map((entry) => entry.rel)])) digests[rel] = await digestOf(path.join(lower, rel));
  return { public: { created: pick(created), modified: pick(modified), deleted: pick(deleted), touched: pick(touched) }, git, entries, digests };
}

/** Delete the rehearsal's private state. */
export async function disposeRehearsal(result) {
  if (result && result.keep && result.keep.state) {
    await rm(result.keep.state, { recursive: true, force: true }).catch(() => {});
    result.keep = null;
  }
}

/**
 * Copy a rehearsal's changes into the real workspace. Refuses (and changes nothing)
 * when any path it touches changed since the rehearsal, or when it changed .git.
 */
export async function applyRehearsal(result, { includeGit = false } = {}) {
  if (!result || !result.keep) throw new Error('This rehearsal has no changes left to apply.');
  const { upper, lower, entries, digests } = result.keep;
  const conflicts = [];
  for (const [rel, digest] of Object.entries(digests)) {
    if (await digestOf(path.join(lower, rel)) !== digest) conflicts.push(rel);
  }
  if (conflicts.length) return { applied: false, conflicts: conflicts.sort(), message: 'The workspace changed since the rehearsal: ' + conflicts.slice(0, 10).join(', ') + '. Nothing was applied; rehearse again.' };
  if (result.git && !includeGit) return { applied: false, conflicts: [], message: 'The rehearsal changed ' + result.git + ' path(s) inside .git; run the command for real instead of applying it.' };
  for (const entry of entries) {
    const target = path.join(lower, entry.rel);
    if (!pathContains(lower, target)) continue;
    if (entry.kind === 'delete') { await rm(target, { recursive: true, force: true }); continue; }
    if (entry.kind === 'dir') {
      let info = null;
      try { info = await lstat(target); } catch {}
      if (info && !info.isDirectory()) await unlink(target);
      await mkdir(target, { recursive: true });
      await chmod(target, entry.mode).catch(() => {});
      continue;
    }
    let info = null;
    try { info = await lstat(target); } catch {}
    if (info && info.isDirectory()) await rm(target, { recursive: true, force: true });
    if (entry.kind === 'link') {
      await rm(target, { force: true });
      await symlink(entry.target, target);
      continue;
    }
    const temp = target + '.oasis-rehearsal-' + process.pid;
    await writeFile(temp, await readFile(path.join(upper, entry.rel)), { mode: entry.mode });
    await chmod(temp, entry.mode).catch(() => {});
    await rename(temp, target);
  }
  const changes = result.changes;
  await disposeRehearsal(result);
  return { applied: true, conflicts: [], changes, message: 'Applied ' + (changes.created.length + changes.modified.length + changes.deleted.length) + ' change(s) from the rehearsal.' };
}

function listed(label, items) {
  if (!items.length) return '';
  const shown = items.slice(0, 8).join(', ');
  return '\n  ' + label + ' (' + items.length + '): ' + shown + (items.length > 8 ? ', ...' : '');
}

/** Lines for an approval prompt. */
const contactLabel = (item) => (item.host.includes(':') ? '[' + item.host + ']' : item.host) + (item.port && item.port !== 443 && item.port !== 80 ? ':' + item.port : '');

export function formatRehearsal(result) {
  if (!result) return '';
  if (result.status === 'unavailable') return '';
  if (result.status === 'error') return 'Rehearsal could not run: ' + String(result.stderr || 'no report').trim().split('\n').pop().slice(0, 200);
  const { created, modified, deleted } = result.changes;
  const head = result.status === 'timeout'
    ? 'Rehearsal (network off, nothing kept) did not finish in ' + Math.round(result.ms / 1000) + 's; it changed so far:'
    : 'Rehearsal (network off, nothing kept): exit ' + result.exitCode + ' in ' + result.ms + ' ms.';
  const none = !created.length && !modified.length && !deleted.length;
  return head
    + (none ? '\n  It changed no files in the workspace.' : listed('would create', created) + listed('would modify', modified) + listed('would delete', deleted))
    + (result.git ? '\n  It also changed ' + result.git + ' path(s) inside .git.' : '')
    + (result.readOnlyWrites ? '\n  It tried to write outside the workspace (refused in the rehearsal; the real run may succeed there).' : '')
    + (result.contacts && result.contacts.length ? '\n  It tried to reach ' + result.contacts.slice(0, 8).map(contactLabel).join(', ') + (result.contacts.length > 8 ? ', ...' : '') + ' (refused: nothing was sent).' : '')
    + (result.status === 'failed' && !result.network ? '\n  It failed; it may need the network, which the rehearsal does not have.' : '');
}

/** Short form for tool results and the model. */
export function publicRehearsal(result) {
  if (!result || result.status === 'unavailable') return null;
  const cap = (items) => items.slice(0, MAX_LISTED);
  return { status: result.status, exitCode: result.exitCode, ms: result.ms, created: cap(result.changes.created), modified: cap(result.changes.modified), deleted: cap(result.changes.deleted), ...(result.git ? { gitPaths: result.git } : {}), ...(result.readOnlyWrites ? { wroteOutsideWorkspace: true } : {}), ...(result.contacts && result.contacts.length ? { contacted: result.contacts.slice(0, MAX_LISTED).map(contactLabel) } : {}) };
}

/**
 * Compare a rehearsal with the effects the real run produced (effect contracts' observed
 * paths, as { created, modified, deleted }). Returns null when nothing unrehearsed changed.
 */
export function rehearsalDivergence(result, observed) {
  if (!result || result.status === 'unavailable' || !observed) return null;
  const expected = new Set([...result.changes.created, ...result.changes.modified, ...result.changes.deleted]);
  const actual = [...new Set([...(observed.created || []), ...(observed.modified || []), ...(observed.deleted || [])])].filter((rel) => rel !== '.git' && !rel.startsWith('.git/'));
  // Only this direction matters for safety: the real run changed something the person was
  // not shown. (A rehearsed path the real run left alone is usually ignored by .gitignore,
  // which effect snapshots skip.)
  const unrehearsed = actual.filter((rel) => !expected.has(rel)).sort();
  if (!unrehearsed.length) return null;
  return { unrehearsed, note: 'The real run changed files its rehearsal did not: ' + unrehearsed.slice(0, 8).join(', ') + (unrehearsed.length > 8 ? ', ...' : '') + '. The command behaves differently from run to run (time, network, randomness); check those files.' };
}

/**
 * Rehearse a command about to be shown in an approval prompt, when enabled. Returns
 * { text, summary } (empty when skipped) and never throws. A command headed for SSH or a
 * container runs somewhere else, and one held because of suspected prompt injection is not
 * started at all, so neither is rehearsed.
 */
/**
 * Whether a rehearsal can stand in for the real run: it finished with exit 0, changed
 * something, wrote nothing outside the workspace and left .git alone. Its network was off,
 * so a command that needed the network fails its rehearsal and is never offered.
 */
export function rehearsalApplicable(result) {
  if (!result || result.status !== 'ok' || result.exitCode !== 0 || !result.keep) return false;
  // A command that wanted the network may have produced something different without it.
  if (result.readOnlyWrites || result.git || (result.contacts && result.contacts.length)) return false;
  const { created, modified, deleted } = result.changes;
  return created.length + modified.length + deleted.length > 0;
}

export async function rehearseForApproval({ root, command, args = [], line = null, env = process.env, settings = {}, sandbox = null, injectionHold = '', keep = false } = {}) {
  const skip = { text: '', summary: null };
  if (!rehearsalEnabled(env, settings, sandbox) || injectionHold) return skip;
  if (sandbox && sandbox.available && sandbox.kind !== 'bubblewrap') return skip;
  try {
    // rehearseCommand already scrubs the environment and hides the default credential paths;
    // add the sandbox's own masks (denyRead) so the rehearsal sees no more than the real run.
    const masked = sandbox && Array.isArray(sandbox.maskedPaths) ? sandbox.maskedPaths : [];
    const result = line === null
      ? await rehearseCommand({ root, command, args, env, masked })
      : await rehearseCommand({ root, command: '/bin/sh', args: ['-c', line], env, masked });
    // keep: the caller may offer "apply exactly this" and then calls disposeRehearsal(kept).
    const kept = keep && rehearsalApplicable(result) ? result : null;
    if (!kept) await disposeRehearsal(result);
    if (result.status === 'unavailable') return skip;
    return { text: '\n' + formatRehearsal(result), summary: publicRehearsal(result), ...(kept ? { kept } : {}) };
  } catch {
    return skip;
  }
}

/** Divergence between a rehearsal summary and the effect contract's observed paths. */
export function summaryDivergence(summary, observedPaths) {
  if (!summary || !Array.isArray(observedPaths)) return null;
  return rehearsalDivergence({ status: summary.status, changes: { created: summary.created || [], modified: summary.modified || [], deleted: summary.deleted || [] } }, { modified: observedPaths });
}
