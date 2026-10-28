import { existsSync } from 'node:fs';
import path from 'node:path';

// Synchronous PATH lookup without spawning a shell.
export function onPathSync(name, env = process.env, platform = process.platform) {
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const exts = platform === 'win32' ? String(env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
  for (const dir of dirs) for (const ext of exts) if (existsSync(path.join(dir, name + (name.includes('.') ? '' : ext)))) return true;
  return false;
}
