// Checkpoints: every user turn records the original content of each file Oasis
// edits, writes, or deletes, right before the first change in that turn. /rewind
// restores those files (deleting files the turn created) and can also drop the
// conversation back to before that turn. Changes made by shell commands are not
// tracked, matching Claude Code's checkpoint behaviour.
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveWorkspacePath } from './tools.mjs';

export const FILE_CHANGING_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'delete_file']);
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
        if (message.role === 'user' && message.content === marker.content) { cut = i; break; }
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
