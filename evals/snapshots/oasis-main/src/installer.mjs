import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const NPM_GLOBAL_PACKAGES = new Set(['pnpm', 'wrangler', 'vercel', 'netlify-cli', 'npm-check-updates']);
const NPM_PROJECT_TOOLS = new Set(['typescript', 'tsc', 'eslint', 'prettier', 'vite', 'playwright', 'vitest', 'tsx', 'nodemon', 'turbo', 'biome']);
const NPM_CLI_PACKAGES = new Set([
  'pnpm', 'typescript', 'tsc', 'eslint', 'prettier', 'vite', 'playwright',
  'vitest', 'tsx', 'nodemon', 'serve', 'http-server', 'turbo', 'wrangler',
  'vercel', 'netlify-cli', 'npm-check-updates', 'biome'
]);
const PYTHON_CLI_PACKAGES = new Set(['ruff', 'black', 'pytest', 'poetry', 'uvicorn']);
const SYSTEM_ALIASES = new Map([
  ['rg', 'ripgrep'], ['fd', 'fd-find'], ['gh', 'gh'], ['github cli', 'gh'],
  ['python', 'python3'], ['node.js', 'nodejs'], ['ripgrep', 'ripgrep']
]);

export function normalizePackageName(raw) {
  const name = String(raw || '').trim().replace(/^["']|["']$/g, '');
  if (!name || name.length > 180) throw new Error('Provide one package name between 1 and 180 characters.');
  if (/^(?:https?:|git\+|file:|ssh:)/i.test(name) || name.includes(':') || name.includes(String.fromCharCode(96)) || /^[\-./]|[\s;&|$<>\\]/.test(name) || /(^|\/)\.\.?($|\/)/.test(name)) {
    throw new Error('Package names must be a single package identifier, not a command or a path.');
  }
  return name;
}

export function parseInstallIntent(text) {
  const original = String(text || '').trim();
  if (!/^(?:please\s+)?(?:can you\s+)?install\b/i.test(original)) return null;
  if (/\b(?:and then|then configure|and configure|and set up|and setup|and build|and test)\b/i.test(original)) return null;
  let rest = original.replace(/^(?:please\s+)?(?:can you\s+)?install\s+/i, '').trim();
  if (/^(?:yourself|the oasis cli|oasis|oasis-oss|oasis oss|oasis itself)[.!?]*$/i.test(rest)) return { action: 'self' };
  let ecosystem = 'auto';
  const prefix = rest.match(/^(npm package|node package|python package|pip package|system tool|system package|global npm package)\s+/i);
  if (prefix) {
    const kind = prefix[1].toLowerCase();
    ecosystem = kind === 'global npm package' ? 'npm-global' :
      (kind.startsWith('npm ') || kind.startsWith('node ') ? 'npm' :
      (kind.includes('python') || kind.includes('pip') ? 'pip' : 'system'));
    rest = rest.slice(prefix[0].length);
  }
  rest = rest.replace(/\s+(?:in|into)\s+(?:yourself|your environment|your setup|the current environment)$/i, '');
  rest = rest.replace(/\s+(?:yourself|itself)$/i, '');
  rest = rest.replace(/\s+(?:for me|for this project|on this machine|on my machine|on my system)$/i, '');
  rest = rest.replace(/\s+(?:please|thanks)[.!?]*$/i, '');
  rest = rest.replace(/[.!?]+$/, '').trim();
  if (!rest || /\s/.test(rest) || /(?:https?:|git\+|file:|--)/i.test(rest)) return null;
  try {
    const packageName = normalizePackageName(rest);
    return { packageName, ecosystem };
  } catch { return null; }
}

function commandExists(command) {
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(probe, [command], { encoding: 'utf8', stdio: 'ignore', timeout: 1500, windowsHide: true });
  return result.status === 0;
}

export function resolveEcosystem(packageName, requested = 'auto', workspaceRoot = process.cwd()) {
  if (requested !== 'auto') return requested;
  const lower = packageName.toLowerCase();
  if (NPM_GLOBAL_PACKAGES.has(lower)) return 'npm-global';
  if (NPM_PROJECT_TOOLS.has(lower)) return 'npm';
  if (NPM_CLI_PACKAGES.has(lower) && !existsSync(path.join(workspaceRoot, 'package.json'))) return 'npm-global';
  if (PYTHON_CLI_PACKAGES.has(lower)) return 'pipx';
  if (SYSTEM_ALIASES.has(lower) || ['git', 'jq', 'yq', 'tmux', 'docker', 'podman', 'ollama', 'bun', 'deno', 'uv', 'nodejs', 'python3'].includes(lower)) return 'system';
  if (existsSync(path.join(workspaceRoot, 'package.json'))) return 'npm';
  return 'system';
}

function validateNpmSpec(name) {
  if (!/^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*(?:@[a-z0-9._+-]+)?$/i.test(name)) {
    throw new Error('For safety, npm installs must use a package name with an optional version, not a URL or local path.');
  }
}
function validatePythonSpec(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*(?:[<>=!~]+[A-Za-z0-9.*+-]+)?$/.test(name)) {
    throw new Error('For safety, Python installs must use a package name and optional version constraint, not a URL or local path.');
  }
}
function validateSystemPackage(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9.+:@_-]*$/.test(name)) {
    throw new Error('For safety, system installs must use a single package name or exact package ID.');
  }
}

export function planPackageInstall({ packageName, ecosystem = 'auto', workspaceRoot = process.cwd(), env = process.env } = {}) {
  const original = normalizePackageName(packageName);
  const alias = SYSTEM_ALIASES.get(original.toLowerCase());
  const chosen = resolveEcosystem(original, ecosystem, workspaceRoot);
  const name = (ecosystem === 'system' || chosen === 'system') && alias ? alias : original;

  if (chosen === 'npm' || chosen === 'npm-global') {
    validateNpmSpec(name);
    if (!commandExists('npm')) throw new Error('npm is not on PATH. Install Node.js with npm first, then run oasis doctor.');
    const args = chosen === 'npm-global' ? ['install', '--global', name] : ['install', name];
    return { command: 'npm', args, packageName: name, ecosystem: chosen, note: 'npm packages may run third-party lifecycle scripts during installation.' };
  }
  if (chosen === 'pip' || chosen === 'pipx') {
    validatePythonSpec(name);
    const python = commandExists('python3') ? 'python3' : (commandExists('python') ? 'python' : null);
    if (chosen === 'pipx' && commandExists('pipx')) {
      return { command: 'pipx', args: ['install', name], packageName: name, ecosystem: chosen, note: 'pipx creates an isolated Python environment for this command-line tool.' };
    }
    if (!python) throw new Error('Python is not on PATH. Run oasis doctor or select another package ecosystem.');
    const actualEcosystem = chosen === 'pipx' ? 'pipx-fallback' : 'pip';
    return {
      command: python,
      args: ['-m', 'pip', 'install', '--user', name],
      packageName: name,
      ecosystem: actualEcosystem,
      note: chosen === 'pipx' ? 'pipx is not installed; this uses the user Python package location as a fallback.' : 'Python package installation may be blocked by externally managed environment rules.'
    };
  }
  if (chosen === 'cargo') {
    validateSystemPackage(name);
    if (!commandExists('cargo')) throw new Error('Cargo is not on PATH.');
    return { command: 'cargo', args: ['install', name], packageName: name, ecosystem: chosen, note: 'Cargo may compile third-party source code locally.' };
  }
  if (chosen === 'go') {
    if (!name.includes('/') || !/^[A-Za-z0-9._+-]+(?:\/[A-Za-z0-9._+-]+)+$/.test(name)) throw new Error('Go installs require a module path such as example.com/org/tool.');
    if (!commandExists('go')) throw new Error('Go is not on PATH.');
    return { command: 'go', args: ['install', name], packageName: name, ecosystem: chosen, note: 'Go will download and compile the selected module.' };
  }
  if (chosen !== 'system') throw new Error('Unsupported package ecosystem: ' + chosen);
  validateSystemPackage(name);

  if (process.platform === 'win32') {
    if (!commandExists('winget')) throw new Error('winget is unavailable. Configure a supported package manager, then run oasis doctor.');
    return { command: 'winget', args: ['install', '--id', name, '--exact', '--accept-source-agreements', '--accept-package-agreements'], packageName: name, ecosystem: 'winget', note: 'The package name is treated as an exact Windows Package Manager ID.' };
  }
  if (process.platform === 'darwin') {
    if (!commandExists('brew')) throw new Error('Homebrew is not on PATH. Configure a package manager, then run oasis doctor.');
    return { command: 'brew', args: ['install', name], packageName: name, ecosystem: 'brew', note: 'Homebrew may run install hooks and may request system permission.' };
  }
  if (process.platform === 'linux' && (env.TERMUX_VERSION || String(env.PREFIX || '').includes('com.termux')) && commandExists('pkg')) {
    return { command: 'pkg', args: ['install', '-y', name], packageName: name, ecosystem: 'termux-pkg', note: 'Termux package names must match its repositories.' };
  }
  if (process.platform === 'linux') {
    const nonRoot = typeof process.getuid === 'function' && process.getuid() !== 0;
    if (commandExists('apt-get')) {
      return { command: nonRoot && commandExists('sudo') ? 'sudo' : 'apt-get', args: nonRoot && commandExists('sudo') ? ['apt-get', 'install', '-y', name] : ['install', '-y', name], packageName: name, ecosystem: 'apt', note: 'System package installation may require administrator permission.' };
    }
    if (commandExists('dnf')) {
      return { command: nonRoot && commandExists('sudo') ? 'sudo' : 'dnf', args: nonRoot && commandExists('sudo') ? ['dnf', 'install', '-y', name] : ['install', '-y', name], packageName: name, ecosystem: 'dnf', note: 'System package installation may require administrator permission.' };
    }
    if (commandExists('pacman')) {
      return { command: nonRoot && commandExists('sudo') ? 'sudo' : 'pacman', args: nonRoot && commandExists('sudo') ? ['pacman', '-S', '--noconfirm', name] : ['-S', '--noconfirm', name], packageName: name, ecosystem: 'pacman', note: 'System package installation may require administrator permission.' };
    }
    if (commandExists('zypper')) {
      return { command: nonRoot && commandExists('sudo') ? 'sudo' : 'zypper', args: nonRoot && commandExists('sudo') ? ['zypper', '--non-interactive', 'install', name] : ['--non-interactive', 'install', name], packageName: name, ecosystem: 'zypper', note: 'System package installation may require administrator permission.' };
    }
  }
  throw new Error('Could not detect a supported package manager for this system. Run oasis doctor, or choose npm, pip, pipx, cargo, or go explicitly.');
}
