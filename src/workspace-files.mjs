// A capped, read-only list of the files in a workspace for the app's Files
// panel. It skips dependency and build folders and anything that looks like a
// secret, and never follows symbolic links.
import { readdir } from 'node:fs/promises';
import path from 'node:path';

const SKIP_DIRS = new Set(['.git', '.oasis', 'node_modules', 'dist', 'build', 'out', '.next', '.nuxt', 'target', '__pycache__', '.venv', 'venv', '.cache', '.turbo', 'coverage', '.gradle', '.idea', 'Pods', 'DerivedData']);

export async function listWorkspaceFiles(root, { limit = 3000, isSecretPath = () => false } = {}) {
  const files = [];
  let truncated = false;
  const queue = [''];
  while (queue.length) {
    const rel = queue.shift();
    let entries;
    try { entries = await readdir(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const child = rel ? rel + '/' + entry.name : entry.name;
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) { if (!SKIP_DIRS.has(entry.name)) queue.push(child); continue; }
      if (!entry.isFile()) continue;
      let secret = false;
      try { secret = Boolean(isSecretPath(child)); } catch { secret = true; }
      if (secret) continue;
      if (files.length >= limit) { truncated = true; break; }
      files.push(child);
    }
    if (truncated) break;
  }
  files.sort();
  return { files, truncated };
}
