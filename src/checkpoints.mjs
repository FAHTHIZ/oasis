// Checkpoints: every user turn records the original content of each file Oasis
// edits, writes, or deletes, right before the first change in that turn. /rewind
// restores those files (deleting files the turn created) and can also drop the
// conversation back to before that turn. Changes made by shell commands are not
// tracked, matching Claude Code's checkpoint behaviour.
import { createHash } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath } from './tools.mjs';

export const FILE_CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'notebook_edit', 'delete_file']);
const MAX_CHECKPOINT_FILE = 5 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 100 * 1024 * 1024;
const MAX_TURNS = 50;

export function ensureCheckpoints(session) {
  if (!session.checkpoints) session.checkpoints = { turns: [], bytes: 0 };
  return session.checkpoints;
}

// `userMessage` is the turn's user message; rewinding the conversation cuts the
// history just before it (found by identity, then by identical content, since
// compaction can replace message objects).
export function beginCheckpoint(session, userMessage, prompt) {
  const store = ensureCheckpoints(session);
  store.turns.push({ userMessage, prompt: String(prompt || '').slice(0, 200), createdAt: new Date().toISOString(), files: new Map() });
  while (store.turns.length > MAX_TURNS) {
    const dropped = store.turns.shift();
    for (const entry of dropped.files.values()) store.bytes -= entry.content ? entry.content.length : 0;
  }
  return store.turns.at(-1);
}

// Record a file's state before its first change in the current turn.
export async function captureBeforeChange(session, root, toolName, args = {}) {
  if (!FILE_CHANGING_TOOLS.has(toolName) || !session.checkpoints) return;
  const turn = session.checkpoints.turns.at(-1);
  if (!turn) return;
  let target;
  try { target = await resolveWorkspacePath(root, args.path, { rejectSymlinks: true }); } catch { return; }
  if (turn.files.has(target.relative)) return;
  let info = null;
  try { info = await lstat(target.absolute); } catch {}
  if (!info) { turn.files.set(target.relative, { existed: false, content: null }); return; }
  if (!info.isFile() || info.size > MAX_CHECKPOINT_FILE || session.checkpoints.bytes + info.size > MAX_CHECKPOINT_BYTES) {
    turn.files.set(target.relative, { existed: true, content: null, skipped: true });
    return;
  }
  const content = await readFile(target.absolute);
  session.checkpoints.bytes += content.length;
  turn.files.set(target.relative, { existed: true, content, mode: info.mode });
}

export function listCheckpoints(session) {
  const turns = session && session.checkpoints ? session.checkpoints.turns : [];
  return turns.map((turn, index) => ({ number: turns.length - index, prompt: turn.prompt, createdAt: turn.createdAt, files: [...turn.files.keys()] })).reverse();
}

// Persistence: checkpoints are saved next to the session (`<id>.checkpoints/`)
// so /rewind still works after `--resume` or a restart. File contents are
// stored once per SHA-256 hash; the index lists turns and the files they touched.
const INDEX_VERSION = 1;
const HASH = /^[0-9a-f]{64}$/;

export function checkpointPersistenceEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.OASIS_PERSIST_CHECKPOINTS || '').trim());
}

function markerContent(message) {
  if (!message) return null;
  return typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
}

export async function saveCheckpoints(session, directory) {
  const store = session && session.checkpoints;
  if (!store || !Array.isArray(store.turns)) return { saved: false };
  if (!store.persisted && !store.turns.some((turn) => turn.files && turn.files.size)) return { saved: false };
  const blobs = path.join(directory, 'blobs');
  await mkdir(blobs, { recursive: true, mode: 0o700 });
  const keep = new Set();
  const turns = [];
  for (const turn of store.turns) {
    const files = [];
    for (const [file, entry] of turn.files) {
      const item = { path: file, existed: Boolean(entry.existed) };
      if (entry.skipped) item.skipped = true;
      if (entry.mode) item.mode = entry.mode & 0o7777;
      if (entry.content) {
        const hash = entry.hash || (entry.hash = createHash('sha256').update(entry.content).digest('hex'));
        item.blob = hash;
        if (!keep.has(hash)) {
          keep.add(hash);
          const target = path.join(blobs, hash);
          try { await lstat(target); } catch { await writeFile(target, entry.content, { mode: 0o600 }); }
        }
      }
      files.push(item);
    }
    turns.push({ prompt: turn.prompt, createdAt: turn.createdAt, user: markerContent(turn.userMessage), files });
  }
  await writeFile(path.join(directory, 'index.json'), JSON.stringify({ version: INDEX_VERSION, turns }) + '\n', { mode: 0o600 });
  for (const name of await readdir(blobs).catch(() => [])) if (HASH.test(name) && !keep.has(name)) await unlink(path.join(blobs, name)).catch(() => {});
  store.persisted = true;
  return { saved: true, turns: turns.length, blobs: keep.size };
}

export async function loadCheckpoints(directory) {
  let index;
  try { index = JSON.parse(await readFile(path.join(directory, 'index.json'), 'utf8')); } catch { return null; }
  if (!index || index.version !== INDEX_VERSION || !Array.isArray(index.turns)) return null;
  const store = { turns: [], bytes: 0, persisted: true };
  for (const raw of index.turns.slice(-MAX_TURNS)) {
    if (!raw || !Array.isArray(raw.files)) continue;
    const files = new Map();
    for (const item of raw.files) {
      if (!item || typeof item.path !== 'string' || !item.path || item.path.includes('\0')) continue;
      if (path.isAbsolute(item.path) || item.path.split(/[\\/]/).includes('..')) continue;
      if (!item.existed) { files.set(item.path, { existed: false, content: null }); continue; }
      if (item.skipped || !HASH.test(String(item.blob || ''))) { files.set(item.path, { existed: true, content: null, skipped: true }); continue; }
      let content = null;
      try { content = await readFile(path.join(directory, 'blobs', item.blob)); } catch {}
      if (!content || createHash('sha256').update(content).digest('hex') !== item.blob || store.bytes + content.length > MAX_CHECKPOINT_BYTES) {
        files.set(item.path, { existed: true, content: null, skipped: true });
        continue;
      }
      store.bytes += content.length;
      files.set(item.path, { existed: true, content, hash: item.blob, ...(item.mode ? { mode: item.mode } : {}) });
    }
    const user = typeof raw.user === 'string' ? raw.user : null;
    store.turns.push({ userMessage: user === null ? null : { role: 'user', content: user, restoredMarker: true }, prompt: String(raw.prompt || '').slice(0, 200), createdAt: String(raw.createdAt || ''), files });
  }
  return store;
}

export async function deleteCheckpoints(directory) {
  await rm(directory, { recursive: true, force: true }).catch(() => {});
}

// Undo the last `count` turns. mode: 'both' (default), 'code', or 'conversation'.
export async function rewind(session, count = 1, mode = 'both') {
  const store = session && session.checkpoints;
  if (!store || !store.turns.length) return { restored: [], deleted: [], skipped: [], turns: 0, messagesRemoved: 0 };
  const n = Math.max(1, Math.min(store.turns.length, Number.parseInt(count, 10) || 1));
  const undone = store.turns.slice(-n);
  // The oldest capture of each file is its state before all undone turns.
  const originals = new Map();
  for (const turn of undone) for (const [file, entry] of turn.files) if (!originals.has(file)) originals.set(file, entry);
  const restored = [];
  const deleted = [];
  const skipped = [];
  if (mode !== 'conversation') {
    for (const [file, entry] of originals) {
      const absolute = path.join(session.root, file);
      let target;
      try { target = await resolveWorkspacePath(session.root, file, { rejectSymlinks: true }); } catch { skipped.push(file); continue; }
      if (entry.skipped) { skipped.push(file); continue; }
      if (!entry.existed) {
        try { await unlink(target.absolute); deleted.push(file); } catch (error) { if (error.code !== 'ENOENT') skipped.push(file); }
        continue;
      }
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(target.absolute, entry.content, entry.mode ? { mode: entry.mode & 0o777 } : undefined);
      restored.push(file);
    }
  }
  let messagesRemoved = 0;
  let conversationUnavailable = false;
  if (mode !== 'code') {
    const marker = undone[0].userMessage;
    let cut = session.messages.indexOf(marker);
    if (cut < 0 && marker) {
      for (let i = session.messages.length - 1; i >= 1; i--) {
        const message = session.messages[i];
        if (message.role === 'user' && markerContent(message) === markerContent(marker)) { cut = i; break; }
      }
    }
    if (cut >= 1) {
      messagesRemoved = session.messages.length - cut;
      session.messages = session.messages.slice(0, cut);
    } else conversationUnavailable = true;
  }
  if (mode !== 'code') {
    for (const turn of undone) for (const entry of turn.files.values()) store.bytes -= entry.content ? entry.content.length : 0;
    store.turns.splice(-n, n);
  }
  return { restored, deleted, skipped, turns: n, messagesRemoved, conversationUnavailable, prompts: undone.map((turn) => turn.prompt) };
}
