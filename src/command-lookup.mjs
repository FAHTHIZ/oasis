import { accessSync, constants as fsConstants } from 'node:fs';
import path from 'node:path';

/**
 * Resolve a command using PATH without depending on external "which"/"where"
 * programs. This is important on minimal systems such as Android/Termux.
 */
export function findCommandPath(name, env = process.env, platform = process.platform) {
  if (typeof name !== 'string' || !name.trim()) return null;

  const command = name.trim();
  const windows = platform === 'win32';
  const pathApi = windows ? path.win32 : path.posix;
  const hasPath = pathApi.isAbsolute(command) || command.includes('/') || (windows && command.includes('\\'));
  const directories = hasPath
    ? ['']
    : String(env.PATH || env.Path || '').split(windows ? ';' : ':');
  const extensions = windows
    ? String(env.PATHEXT || env.PathExt || '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)
    : [''];

  for (const directory of directories) {
    const base = hasPath ? command : pathApi.join(directory || '.', command);
    const candidates = windows && !pathApi.extname(base)
      ? extensions.map((extension) => base + extension)
      : [base];

    for (const candidate of candidates) {
      try {
        accessSync(candidate, windows ? fsConstants.F_OK : fsConstants.X_OK);
        return candidate;
      } catch {
        // Keep looking through PATH and Windows executable extensions.
      }
    }
  }
  return null;
}

export function commandAvailable(name, env = process.env, platform = process.platform) {
  return Boolean(findCommandPath(name, env, platform));
}
