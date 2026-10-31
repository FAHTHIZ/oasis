// Session scratch space.
//
// Agents often drop throwaway repro scripts, probe files and temporary output
// into the project root, where they get committed by accident. Each session
// gets .oasis/scratch/<key>/ instead: inside the workspace (so normal tools can
// use it), git-ignored by its own .gitignore, excluded from the verification
// gate, and pruned after a week. Set OASIS_SCRATCH=0 to turn it off.

import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat, writeFile, lstat } from 'node:fs/promises';

export const SCRATCH_ROOT = '.oasis/scratch';
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function scratchEnabled(env = process.env) {
  return !/^(?:0|false|off|no)$/i.test(String(env.OASIS_SCRATCH || ''));
}

export function scratchKey(sessionId) {
  const fromId = String(sessionId || '').replace(/[^a-zA-Z0-9-]/g, '').slice(0, 12);
  return fromId || randomBytes(4).toString('hex');
}

export function scratchRelative(key) {
  return SCRATCH_ROOT + '/' + key;
}

/** True for workspace-relative paths inside any session's scratch folder. */
export function isScratchPath(relative) {
  const normalized = String(relative || '').replace(/\\/g, '/').replace(/^\.\//, '');
  return normalized === SCRATCH_ROOT || normalized.startsWith(SCRATCH_ROOT + '/');
}

export function scratchPrompt(relative) {
  return '<scratch-space>\nFor throwaway files — repro scripts, probes, sample input, temporary output — use ' + relative +
    '/ instead of the project root. It is git-ignored, is not counted as a project change, and is cleaned up after a week. Never put real deliverables there.\n</scratch-space>';
}

/** Creates the folder and its .gitignore, and prunes week-old sibling folders. Best effort. */
export async function ensureScratch(root, key, now = Date.now()) {
  const base = path.join(root, ...SCRATCH_ROOT.split('/'));
  const dir = path.join(base, key);
  try {
    // Refuse to follow a symlinked .oasis or scratch folder out of the workspace.
    for (const candidate of [path.join(root, '.oasis'), base]) {
      const info = await lstat(candidate).catch(() => null);
      if (info && info.isSymbolicLink()) return null;
    }
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(base, '.gitignore'), '# OASIS session scratch space\n*\n', { flag: 'wx' }).catch(() => {});
    for (const entry of await readdir(base, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === key) continue;
      const info = await stat(path.join(base, entry.name)).catch(() => null);
      if (info && now - info.mtimeMs > MAX_AGE_MS) await rm(path.join(base, entry.name), { recursive: true, force: true }).catch(() => {});
    }
    return dir;
  } catch {
    return null;
  }
}
