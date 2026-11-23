// VS Code and VS Code Insiders keep user-level prompt files, custom agents and
// chat modes in the profile's User/prompts folder.
import os from 'node:os';
import path from 'node:path';

export function vscodeUserPromptDirs(env = process.env, home = os.homedir(), platform = process.platform) {
  const bases = platform === 'darwin' ? [path.join(home, 'Library', 'Application Support')]
    : platform === 'win32' ? [env.APPDATA || path.join(home, 'AppData', 'Roaming')]
      : [env.XDG_CONFIG_HOME || path.join(home, '.config')];
  return bases.flatMap((base) => ['Code', 'Code - Insiders'].map((app) => path.join(base, app, 'User', 'prompts')));
}
