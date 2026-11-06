// Locates the ripgrep binary used by the grep tool.
//
// OASIS depends on @vscode/ripgrep (MIT), which installs a prebuilt rg for the
// current platform as an optional dependency (@vscode/ripgrep-<os>-<arch>), the
// same binaries VS Code ships. Order: OASIS_RIPGREP_PATH, the bundled binary, rg
// on PATH. When none exists (an unsupported platform, or optional dependencies
// were skipped), grep falls back to its built-in JavaScript search.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);
const cache = new Map();

/** Path of the bundled rg for this platform, or null. */
export function bundledRipgrepPath() {
  const binary = process.platform === 'win32' ? 'rg.exe' : 'rg';
  try {
    const file = require.resolve('@vscode/ripgrep-' + process.platform + '-' + process.arch + '/bin/' + binary);
    return existsSync(file) ? file : null;
  } catch { return null; }
}

function works(command) {
  try { return spawnSync(command, ['--version'], { stdio: 'ignore', timeout: 3000, windowsHide: true }).status === 0; } catch { return false; }
}

/**
 * The rg to run and where it came from: { path, source: 'env' | 'bundled' | 'path' },
 * or null when no working ripgrep is available.
 */
export function resolveRipgrep(env = process.env) {
  const override = env.OASIS_RIPGREP_PATH ? path.resolve(String(env.OASIS_RIPGREP_PATH)) : '';
  const key = override + '\0' + (env.PATH || env.Path || '');
  if (cache.has(key)) return cache.get(key);
  let found = null;
  if (override && works(override)) found = { path: override, source: 'env' };
  if (!found) { const bundled = bundledRipgrepPath(); if (bundled && works(bundled)) found = { path: bundled, source: 'bundled' }; }
  if (!found && works('rg')) found = { path: 'rg', source: 'path' };
  cache.set(key, found);
  return found;
}

/** One-line description for doctor reports. */
export function describeRipgrep(env = process.env) {
  const rg = resolveRipgrep(env);
  if (!rg) return null;
  return rg.source === 'bundled' ? 'bundled (@vscode/ripgrep)' : rg.source === 'env' ? 'OASIS_RIPGREP_PATH (' + rg.path + ')' : 'on PATH';
}

const pathCache = new Map();
/**
 * Folder to append to PATH so `rg` works in the agent's shell commands, as Claude
 * Code does for its Bash tool: the bundled binary's folder when no rg is on PATH,
 * else null. Appended, never prepended, so a user's own rg always wins.
 */
export function ripgrepPathAddition(env = process.env) {
  const key = Object.keys(env).find((name) => name.toUpperCase() === 'PATH') || 'PATH';
  const current = String(env[key] || '');
  if (pathCache.has(current)) return pathCache.get(current);
  const names = process.platform === 'win32' ? ['rg.exe', 'rg.cmd', 'rg.bat'] : ['rg'];
  const onPath = current.split(path.delimiter).filter(Boolean).some((dir) => names.some((name) => existsSync(path.join(dir, name))));
  const bundled = onPath ? null : bundledRipgrepPath();
  const addition = bundled ? path.dirname(bundled) : null;
  pathCache.set(current, addition);
  return addition;
}
