// World drift on resume (docs/CONTINUITY.md).
//
// A saved conversation remembers what the workspace looked like when the model
// last saw it: the files it read and wrote are in its history, and so are the
// branch and commit it worked on. Resume it a day later and that memory may be
// wrong: someone committed, switched branches, rebased, or edited one of those
// files. The in-session reminder (file-state.mjs) only covers changes between
// turns of a live process; its records are not saved.
//
// Every session save records a small fingerprint of the world:
//
//   head, branch      HEAD's commit and symbolic ref (Git work trees only)
//   files             path -> content hash of every file the conversation read,
//                     edited, wrote or deleted (from its tool calls), capped
//   dirty             the count of paths with uncommitted changes
//
// On resume the fingerprint is compared with the workspace, and when anything
// the conversation depends on moved, the first turn starts with a note naming
// it: new commits (with subjects), a branch switch or rewritten history, and
// each known file that changed, appeared or was deleted. Content hashes, not
// mtimes, so a checkout that restores the same bytes or a touch is not drift.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

export const MAX_TRACKED_FILES = 300;
const MAX_HASH_BYTES = 8 * 1024 * 1024;
const CAPTURE_BUDGET_MS = 1500;
const FILE_TOOLS = new Set(['read_file', 'edit_file', 'write_file', 'multi_edit', 'delete_file', 'notebook_edit', 'view_image', 'Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function worldDriftEnabled(env = process.env, settings = {}) {
  if (/^(?:0|false|off|no)$/i.test(String(env.OASIS_WORLD_DRIFT || ''))) return false;
  return !(settings && settings.worldDrift === false);
}

function git(args, cwd, timeout = 2000) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 4 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', LC_ALL: 'C' } }, (error, stdout) => resolve(error ? null : String(stdout)));
  });
}

function parseArgs(raw) {
  if (raw && typeof raw === 'object') return raw;
  try { return JSON.parse(String(raw || '{}')); } catch { return {}; }
}

/** Workspace-relative paths the conversation's tool calls touched, most recent last. */
export function knownPaths(messages, root) {
  const seen = new Map();
  const note = (value) => {
    if (typeof value !== 'string' || !value.trim()) return;
    const absolute = path.resolve(root, value.trim());
    const relative = path.relative(root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
    const key = relative.split(path.sep).join('/');
    seen.delete(key);
    seen.set(key, true);
  };
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls)) continue;
    for (const call of message.tool_calls) {
      const name = call && call.function && call.function.name;
      if (!name) continue;
      const args = parseArgs(call.function.arguments);
      if (FILE_TOOLS.has(name)) note(args.path || args.file_path || args.notebook_path);
      if (name === 'apply_patch' && typeof args.patch === 'string') {
        for (const match of args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) note(match[1]);
        for (const match of args.patch.matchAll(/^\*\*\* Move to: (.+)$/gm)) note(match[1]);
      }
      if (name === 'multi_edit' && Array.isArray(args.edits)) for (const edit of args.edits) note(edit && (edit.path || edit.file_path));
    }
  }
  return [...seen.keys()].slice(-MAX_TRACKED_FILES);
}

async function fileDigest(absolute) {
  let info;
  try { info = await lstat(absolute); } catch { return null; }
  if (info.isSymbolicLink()) return 'link';
  if (!info.isFile()) return info.isDirectory() ? 'dir' : 'other';
  if (info.size > MAX_HASH_BYTES) return 'size:' + info.size;
  return createHash('sha256').update(await readFile(absolute)).digest('hex').slice(0, 32);
}

/** The fingerprint saved with a session. Never throws; returns null when disabled or out of time. */
export async function captureWorld(root, messages, { env = process.env, settings = {}, budgetMs = CAPTURE_BUDGET_MS } = {}) {
  if (!root || !worldDriftEnabled(env, settings)) return null;
  const started = Date.now();
  try {
    const world = { at: new Date().toISOString(), files: {} };
    const [head, branch, status] = await Promise.all([
      git(['rev-parse', '--verify', '-q', 'HEAD'], root),
      git(['symbolic-ref', '-q', '--short', 'HEAD'], root),
      git(['status', '--porcelain=v1', '-z', '--untracked-files=normal'], root, 3000)
    ]);
    if (head) world.head = head.trim();
    if (branch !== null) world.branch = branch.trim();
    if (status !== null) world.dirty = status.split('\0').filter(Boolean).length;
    for (const relative of knownPaths(messages, root)) {
      if (Date.now() - started > budgetMs) { world.truncated = true; break; }
      world.files[relative] = await fileDigest(path.join(root, relative));
    }
    world.ms = Date.now() - started;
    return world;
  } catch {
    return null;
  }
}

/** Accept only the shape captureWorld writes. */
export function sanitizeWorld(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = { at: typeof value.at === 'string' ? value.at.slice(0, 40) : '', files: {} };
  if (typeof value.head === 'string' && /^[0-9a-f]{40,64}$/.test(value.head)) out.head = value.head;
  if (typeof value.branch === 'string') out.branch = value.branch.slice(0, 250);
  if (Number.isInteger(value.dirty) && value.dirty >= 0) out.dirty = value.dirty;
  if (value.truncated === true) out.truncated = true;
  const files = value.files && typeof value.files === 'object' && !Array.isArray(value.files) ? value.files : {};
  for (const [key, digest] of Object.entries(files).slice(-MAX_TRACKED_FILES)) {
    if (typeof key !== 'string' || !key || key.length > 1000 || key.startsWith('/') || key.split('/').includes('..')) continue;
    if (digest === null || (typeof digest === 'string' && digest.length <= 80)) out.files[key] = digest;
  }
  return out;
}

/**
 * Compare a saved fingerprint with the workspace now. Returns null when nothing the
 * conversation depends on moved, else { head, branch, files: { changed, deleted, created }, dirty }.
 */
export async function compareWorld(saved, root, { env = process.env, settings = {} } = {}) {
  const world = sanitizeWorld(saved);
  if (!world || !root || !worldDriftEnabled(env, settings)) return null;
  const drift = { since: world.at, files: { changed: [], deleted: [], created: [] } };
  let moved = false;
  if (world.head) {
    const now = (await git(['rev-parse', '--verify', '-q', 'HEAD'], root) || '').trim();
    if (now && now !== world.head) {
      moved = true;
      const head = { from: world.head, to: now, relation: 'other', commits: [], count: 0 };
      if (await git(['merge-base', '--is-ancestor', world.head, now], root) !== null) {
        head.relation = 'ahead';
        const log = await git(['log', '--format=%h %s', '-n', '6', world.head + '..' + now], root);
        const count = await git(['rev-list', '--count', world.head + '..' + now], root);
        head.commits = String(log || '').split('\n').filter(Boolean).slice(0, 5);
        head.count = Number.parseInt(String(count || '0'), 10) || head.commits.length;
      } else if (await git(['merge-base', '--is-ancestor', now, world.head], root) !== null) {
        head.relation = 'behind';
        const count = await git(['rev-list', '--count', now + '..' + world.head], root);
        head.count = Number.parseInt(String(count || '0'), 10) || 0;
      } else if (await git(['cat-file', '-e', world.head + '^{commit}'], root) === null) {
        head.relation = 'gone';
      }
      drift.head = head;
    }
    const branch = await git(['symbolic-ref', '-q', '--short', 'HEAD'], root);
    const current = branch === null ? '' : branch.trim();
    if (typeof world.branch === 'string' && current !== world.branch) { moved = true; drift.branch = { from: world.branch, to: current }; }
  }
  for (const [relative, before] of Object.entries(world.files)) {
    const after = await fileDigest(path.join(root, relative));
    if (after === before) continue;
    moved = true;
    if (before === null) drift.files.created.push(relative);
    else if (after === null) drift.files.deleted.push(relative);
    else drift.files.changed.push(relative);
  }
  return moved ? drift : null;
}

function ago(since, now = Date.now()) {
  const then = Date.parse(since || '');
  if (!Number.isFinite(then)) return '';
  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 60) return minutes + ' minute' + (minutes === 1 ? '' : 's') + ' ago';
  const hours = Math.round(minutes / 60);
  if (hours < 48) return hours + ' hour' + (hours === 1 ? '' : 's') + ' ago';
  return Math.round(hours / 24) + ' days ago';
}

function list(items, max = 12) {
  return items.slice(0, max).join(', ') + (items.length > max ? ' and ' + (items.length - max) + ' more' : '');
}

export function driftLines(drift) {
  const out = [];
  if (drift.branch) out.push('The branch changed from ' + (drift.branch.from || '(detached HEAD)') + ' to ' + (drift.branch.to || '(detached HEAD)') + '.');
  if (drift.head) {
    const { relation, count, commits, from, to } = drift.head;
    if (relation === 'ahead') out.push(count + ' new commit' + (count === 1 ? '' : 's') + ' since then' + (commits.length ? ': ' + commits.join('; ') : '') + '.');
    else if (relation === 'behind') out.push('HEAD moved back ' + count + ' commit' + (count === 1 ? '' : 's') + ' (to ' + to.slice(0, 12) + ').');
    else if (relation === 'gone') out.push('The commit the session was on (' + from.slice(0, 12) + ') no longer exists here; history was rewritten.');
    else out.push('HEAD is now ' + to.slice(0, 12) + ', not a descendant of ' + from.slice(0, 12) + ' (rebase, reset or a different branch).');
  }
  const { changed, deleted, created } = drift.files;
  if (changed.length) out.push('Changed: ' + list(changed) + '.');
  if (deleted.length) out.push('Deleted: ' + list(deleted) + '.');
  if (created.length) out.push('Now exist (were missing): ' + list(created) + '.');
  return out;
}

/** The note the first resumed turn starts with. */
export function driftNote(drift, now = Date.now()) {
  if (!drift) return '';
  const when = ago(drift.since, now);
  return '<workspace-drift>The workspace changed since this conversation was last saved' + (when ? ' (' + when + ')' : '') + '. ' + driftLines(drift).join(' ')
    + ' What earlier messages show of these files and of the repository is out of date: read them again before relying on them, and do not undo changes you did not make.</workspace-drift>';
}

/** One line for the person resuming. */
export function driftSummary(drift) {
  if (!drift) return '';
  return '[session] The workspace changed since this session was saved: ' + driftLines(drift).join(' ') + ' The model will be told.';
}
