// Persistent prompt history (~/.oasis/history.jsonl), scoped per workspace
// like Claude Code: Up/Down and Ctrl+R show prompts typed in this project.
import { appendFile, mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const MAX_ENTRIES = 2000;
const MAX_ENTRY_CHARS = 20000;

export function historyPath(env = process.env) {
  return path.join(getConfigDirectory(env), 'history.jsonl');
}

async function readEntries(env) {
  let raw = '';
  try { raw = await readFile(historyPath(env), 'utf8'); } catch { return []; }
  const entries = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry && typeof entry.text === 'string') entries.push(entry);
    } catch {}
  }
  return entries;
}

// Returns prompts for `root`, oldest first, without consecutive duplicates.
export async function loadHistory(root, { env = process.env, limit = 500 } = {}) {
  if (env.OASIS_NO_HISTORY === '1') return [];
  const wanted = path.resolve(root);
  const out = [];
  for (const entry of await readEntries(env)) {
    if (entry.root && path.resolve(entry.root) !== wanted) continue;
    if (out[out.length - 1] === entry.text) continue;
    out.push(entry.text);
  }
  return out.slice(-limit);
}

export async function appendHistory(root, text, { env = process.env } = {}) {
  const value = String(text || '');
  if (env.OASIS_NO_HISTORY === '1' || !value.trim() || value.length > MAX_ENTRY_CHARS) return false;
  // Lines starting with a space are kept out of history (shell convention).
  if (value.startsWith(' ')) return false;
  const file = historyPath(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await appendFile(file, JSON.stringify({ text: value, root: path.resolve(root), at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  try { await chmod(file, 0o600); } catch {}
  const entries = await readEntries(env);
  if (entries.length > MAX_ENTRIES * 1.25) {
    await writeFile(file, entries.slice(-MAX_ENTRIES).map((entry) => JSON.stringify(entry)).join('\n') + '\n', { mode: 0o600 });
  }
  return true;
}
