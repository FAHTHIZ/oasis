// Optional OS-level sandbox for agent-run commands.
//
// Linux: bubblewrap (bwrap). The host filesystem is mounted read-only, the
//   workspace (and configured extra directories) are writable, /tmp is a private
//   tmpfs, PID namespace is isolated, and network is unshared unless enabled.
//   Common host credential paths are masked when detected; this is defense in depth,
//   not complete filesystem-read isolation.
// macOS: sandbox-exec with a profile that denies file writes outside the
//   workspace and temp folders and, unless enabled, denies network access.
// Container backend (any platform, including Windows): "backend": "docker" or
//   "podman" runs each command in a throwaway container from "image" with only
//   the workspace (and extra directories) bind-mounted, all capabilities
//   dropped, no-new-privileges, a PID limit, and --network none unless network
//   is enabled. Nothing else from the host filesystem is visible.
// Domain filtering (Linux and macOS): "allowedDomains": ["registry.npmjs.org", ...]
//   runs commands under Anthropic's sandbox-runtime (src/sandbox-runtime.mjs),
//   whose proxy allows only those hosts; the filesystem policy is the same.
// Other platforms report the OS sandbox as unavailable; Oasis then falls back to
// approvals. Enable with settings { "sandbox": { "enabled": true } } or OASIS_SANDBOX=1.
import { normalizeSshSettings, detectSshRuntime, sshWrap } from './ssh-backend.mjs';
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync, lstatSync, rmdirSync, unlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SENSITIVE_HOME_PATHS = [
  '.ssh', '.aws', '.azure', '.kube', '.docker', '.gnupg',
  '.claude', '.codex', '.netrc', '.npmrc', '.git-credentials', '.pgpass',
  path.join('.config', 'gcloud'), path.join('.config', 'gh'), path.join('.config', 'oasis')
];

const DOMAIN = /^(\*\.)?[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?)*(:\d{1,5})?$/i;

/** Valid domain patterns ("example.com", "*.npmjs.org", "host:8080") from a settings value. */
export function domainList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((item) => typeof item === 'string').map((item) => item.trim().toLowerCase()).filter((item) => DOMAIN.test(item)))].slice(0, 500);
}

function pathContains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export function collectSensitivePaths(env = process.env) {
  const home = path.resolve(env.HOME || os.homedir());
  const configPath = path.resolve(env.OASIS_CONFIG_DIR || env.OASIS_HOME || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'oasis'));
  const candidates = [...SENSITIVE_HOME_PATHS.map((item) => path.join(home, item)), configPath];
  const masked = [];
  for (const candidate of candidates) {
    let real;
    let info;
    try { real = realpathSync(candidate); info = statSync(real); } catch { continue; }
    const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null;
    if (!type) continue;
    if (masked.some((item) => pathContains(item.path, real))) continue;
    masked.push({ path: real, type });
  }
  return masked;
}

export const PROTECTED_FILES = ['.bashrc', '.bash_profile', '.zshrc', '.zprofile', '.profile', '.gitconfig', '.gitmodules', '.ripgreprc', '.mcp.json',
  '.claude/settings.json', '.claude/settings.local.json', '.oasis/settings.json', '.oasis/settings.local.json', '.git/config'];
export const PROTECTED_DIRS = ['.vscode', '.idea', '.git/hooks', '.claude/commands', '.claude/agents', '.claude/skills', '.claude/hooks',
  '.oasis/commands', '.oasis/agents', '.oasis/skills', '.oasis/hooks'];
const PLACEHOLDER_FILES = new Set(['.mcp.json', '.claude/settings.json', '.claude/settings.local.json', '.oasis/settings.json', '.oasis/settings.local.json', '.git/config']);

function lstatOrNull(target) { try { return lstatSync(target); } catch { return null; } }

export function protectedWritePaths(roots = []) {
  const existing = [];
  const missing = [];
  const seen = new Set();
  for (const root of roots) {
    const base = path.resolve(root);
    if (!lstatOrNull(base)) continue;
    const dotGit = lstatOrNull(path.join(base, '.git'));
    const candidates = [...PROTECTED_FILES.map((rel) => ({ rel, type: 'file' })), ...PROTECTED_DIRS.map((rel) => ({ rel, type: 'directory' }))]
      .filter((item) => !(dotGit && dotGit.isFile() && item.rel.startsWith('.git/')));
    if (dotGit && dotGit.isFile()) candidates.push({ rel: '.git', type: 'file' });
    for (const item of candidates) {
      const full = path.join(base, ...item.rel.split('/'));
      if (seen.has(full)) continue;
      const info = lstatOrNull(full);
      if (info) { seen.add(full); existing.push({ path: full, type: info.isDirectory() ? 'directory' : 'file' }); continue; }
      if (item.type === 'file' && !PLACEHOLDER_FILES.has(item.rel)) continue;
      const parts = item.rel.split('/');
      let first = null;
      for (let i = 1; i <= parts.length; i++) {
        const candidate = path.join(base, ...parts.slice(0, i));
        if (!lstatOrNull(candidate)) { first = { path: candidate, type: i === parts.length ? item.type : 'directory' }; break; }
      }
      if (!first || seen.has(first.path)) continue;
      seen.add(first.path);
      missing.push(first);
    }
  }
  return { existing, missing };
}

export function removeSandboxPlaceholders(placeholders = []) {
  for (const item of placeholders) {
    const info = lstatOrNull(item.path);
    if (!info) continue;
    try {
      if (item.type === 'directory' && info.isDirectory()) rmdirSync(item.path);
      else if (item.type === 'file' && info.isFile() && info.size === 0) unlinkSync(item.path);
    } catch {}
  }
}
const pendingPlaceholders = new Set();
let exitSweepInstalled = false;
function trackPlaceholders(list) {
  if (!list.length) return () => {};
  for (const item of list) pendingPlaceholders.add(item);
  if (!exitSweepInstalled) { exitSweepInstalled = true; process.once('exit', () => removeSandboxPlaceholders([...pendingPlaceholders])); }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const item of list) pendingPlaceholders.delete(item);
    removeSandboxPlaceholders(list);
  };
}

const CACHE_DIRS = [
  '.npm', '.yarn/berry/cache', '.cache/yarn', '.cache/pnpm', '.local/share/pnpm/store', '.bun/install/cache',
  '.cache/pip', '.cache/uv', '.cache/pypoetry', '.cache/go-build', 'go/pkg/mod', '.cargo/registry', '.cargo/git',
  '.m2/repository', '.gradle/caches', '.cache/deno', '.cache/node-gyp', '.cache/ms-playwright', '.cache/huggingface'
];
export function collectCacheDirectories(env = process.env) {
  let home = path.resolve(env.HOME || os.homedir());
  try { home = realpathSync(home); } catch { return []; }
  const found = [];
  for (const relative of CACHE_DIRS) {
    const candidate = path.join(home, ...relative.split('/'));
    let real;
    try { real = realpathSync(candidate); if (!statSync(real).isDirectory()) continue; } catch { continue; }
    if (!pathContains(home, real) || path.resolve(real) === home) continue;
    if (!found.includes(real)) found.push(real);
  }
  return found;
}

let cachedProbe = null;
const containerProbes = new Map();

export const CONTAINER_BACKENDS = ['docker', 'podman'];
export const DEFAULT_CONTAINER_IMAGE = 'node:22-bookworm';

export function detectContainerRuntime(backend, force = false, run = spawnSync) {
  if (!CONTAINER_BACKENDS.includes(backend)) return { available: false, kind: 'none', reason: 'Unknown sandbox backend ' + backend + '. Use os, docker or podman.' };
  if (containerProbes.has(backend) && !force) return containerProbes.get(backend);
  let probe;
  try {
    const result = run(backend, ['version', '--format', '{{.Server.Version}}'], { timeout: 10000, encoding: 'utf8', windowsHide: true });
    probe = result && result.status === 0
      ? { available: true, kind: backend }
      : { available: false, kind: 'none', reason: backend + ' is installed but its engine is not responding' + (result && result.stderr ? ': ' + String(result.stderr).trim().split('\n')[0].slice(0, 200) : '.') + ' Start ' + (backend === 'docker' ? 'Docker Desktop or the docker daemon' : 'the podman machine') + ' and retry.' };
  } catch {
    probe = { available: false, kind: 'none', reason: backend + ' is not installed. Install ' + (backend === 'docker' ? 'Docker Desktop (Windows/macOS) or Docker Engine (Linux)' : 'Podman') + ', or set "backend": "os".' };
  }
  containerProbes.set(backend, probe);
  return probe;
}

export function containerPath(hostPath, platform = process.platform) {
  const resolved = platform === 'win32' ? path.win32.resolve(hostPath) : path.posix.resolve(hostPath);
  if (platform !== 'win32') return resolved;
  const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(resolved);
  if (!match) throw new Error('Cannot map ' + hostPath + ' into the container.');
  return '/host/' + match[1].toLowerCase() + '/' + match[2].replace(/\\/g, '/');
}

function safeContainerValue(value, label) {
  const text = String(value);
  if (!text || /[\u0000-\u001f\u007f]/.test(text)) throw new Error('Sandbox ' + label + ' contains invalid characters.');
  return text;
}

export function containerArgs(command, args, sandbox, cwd, platform = process.platform) {
  const image = safeContainerValue(sandbox.image || DEFAULT_CONTAINER_IMAGE, 'image');
  if (!/^[A-Za-z0-9][A-Za-z0-9._\/:@-]{0,254}$/.test(image)) throw new Error('Sandbox image name is not valid: ' + image);
  const wrapped = ['run', '--rm', '-i', '--init',
    '--network', sandbox.network ? 'bridge' : 'none',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges',
    '--pids-limit', String(sandbox.pidsLimit || 512),
    '--label', 'dev.oasis.sandbox=1',
    '--env', 'HOME=/tmp', '--env', 'CI=1', '--env', 'OASIS_SANDBOXED=1'];
  if (sandbox.readOnlyRoot) {
    wrapped.push('--read-only');
    wrapped.push('--tmpfs', '/tmp:rw,nosuid,nodev,noexec,size=512m');
  }
  if (sandbox.memory) wrapped.push('--memory', safeContainerValue(sandbox.memory, 'memory'));
  if (sandbox.cpus) wrapped.push('--cpus', safeContainerValue(sandbox.cpus, 'cpus'));
  if (platform !== 'win32' && typeof process.getuid === 'function' && sandbox.kind === 'docker') wrapped.push('--user', process.getuid() + ':' + process.getgid());
  if (sandbox.kind === 'podman') wrapped.push('--userns', 'keep-id');
  const seen = new Set();
  for (const dir of sandbox.writable || []) {
    const inside = containerPath(dir, platform);
    if (seen.has(inside)) continue;
    seen.add(inside);
    wrapped.push('--volume', safeContainerValue(dir, 'path') + ':' + inside + ':rw');
  }
  for (const item of protectedWritePaths(sandbox.protectedRoots || []).existing) {
    wrapped.push('--volume', safeContainerValue(item.path, 'path') + ':' + containerPath(item.path, platform) + ':ro');
  }
  const masked = new Set();
  const writableRoots = (sandbox.writable || []).map((dir) => containerPath(dir, platform));
  for (const item of sandbox.maskedPaths || []) {
    if (!item || !['file', 'directory'].includes(item.type) || !item.path) continue;
    const inside = safeContainerValue(containerPath(item.path, platform), 'masked path');
    const mountedBelow = writableRoots.some((root) => {
      const relative = path.posix.relative(root, inside);
      return relative !== '' && relative !== '..' && !relative.startsWith('../') && !path.posix.isAbsolute(relative);
    });
    if (!mountedBelow || masked.has(inside)) continue;
    masked.add(inside);
    if (item.type === 'directory') wrapped.push('--tmpfs', inside + ':rw,nosuid,nodev,noexec,size=1m');
    else wrapped.push('--volume', '/dev/null:' + inside + ':ro');
  }
  wrapped.push('--workdir', containerPath(cwd, platform), image, command, ...args);
  return wrapped;
}

function probeBubblewrap() {
  try {
    const result = spawnSync('bwrap', ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--unshare-pid', '--die-with-parent', 'true'], { timeout: 5000, stdio: 'ignore' });
    return result.status === 0;
  } catch { return false; }
}

function probeSandboxExec() {
  try {
    const result = spawnSync('sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5000, stdio: 'ignore' });
    return result.status === 0;
  } catch { return false; }
}

export function detectSandbox(force = false) {
  if (cachedProbe && !force) return cachedProbe;
  if (process.platform === 'linux') {
    cachedProbe = probeBubblewrap()
      ? { available: true, kind: 'bubblewrap' }
      : { available: false, kind: 'none', reason: 'bubblewrap (bwrap) is not installed or user namespaces are disabled. Install it with your package manager, e.g. apt install bubblewrap.' };
  } else if (process.platform === 'darwin') {
    cachedProbe = probeSandboxExec()
      ? { available: true, kind: 'sandbox-exec' }
      : { available: false, kind: 'none', reason: 'sandbox-exec is unavailable on this macOS host.' };
  } else {
    cachedProbe = { available: false, kind: 'none', reason: 'No supported OS sandbox on ' + process.platform + '; commands use approvals only.' };
  }
  return cachedProbe;
}

function onPath(name) {
  return spawnSync('sh', ['-c', 'command -v ' + name], { stdio: 'ignore' }).status === 0;
}

let cachedRuntimeProbe = null;
export function detectSandboxRuntime(force = false) {
  if (cachedRuntimeProbe && !force) return cachedRuntimeProbe;
  if (process.platform === 'linux') {
    cachedRuntimeProbe = probeBubblewrap() && onPath('socat')
      ? { available: true, kind: 'srt' }
      : { available: false, kind: 'none', reason: 'Domain filtering (sandbox.allowedDomains) needs bubblewrap and socat. Install them with your package manager, e.g. apt install bubblewrap socat.' };
  } else if (process.platform === 'darwin') {
    cachedRuntimeProbe = probeSandboxExec()
      ? { available: true, kind: 'srt' }
      : { available: false, kind: 'none', reason: 'sandbox-exec is unavailable on this macOS host.' };
  } else {
    cachedRuntimeProbe = { available: false, kind: 'none', reason: 'Domain filtering (sandbox.allowedDomains) needs Linux or macOS. Use "network": true or false here.' };
  }
  return cachedRuntimeProbe;
}

export function resolveSandbox(settings = {}, root, force = false) {
  const wanted = settings.sandbox && settings.sandbox.enabled;
  if (!wanted) return { enabled: false, available: false, kind: 'none' };
  const backend = CONTAINER_BACKENDS.includes(settings.sandbox.backend) || settings.sandbox.backend === 'ssh' ? settings.sandbox.backend : 'os';
  const ssh = backend === 'ssh' ? normalizeSshSettings(settings.sandbox.ssh || {}, process.env, root) : null;
  const allowedDomains = domainList(settings.sandbox.allowedDomains);
  const deniedDomains = domainList(settings.sandbox.deniedDomains);
  const filtered = backend === 'os' && allowedDomains.length > 0;
  const probe = filtered ? detectSandboxRuntime(force) : backend === 'os' ? detectSandbox(force) : backend === 'ssh' ? detectSshRuntime(ssh, force) : detectContainerRuntime(backend, force);
  const additionalWritable = ((settings.permissions && settings.permissions.additionalDirectories) || []).map((dir) => path.resolve(root, dir));
  const caches = settings.sandbox.writableCaches === false ? [] : collectCacheDirectories();
  const writable = [root, ...additionalWritable, ...caches.filter((dir) => !pathContains(root, dir))];
  return {
    enabled: true,
    available: probe.available,
    kind: probe.kind,
    reason: probe.reason,
    network: Boolean(settings.sandbox.network),
    ...(filtered ? { allowedDomains, deniedDomains } : {}),
    autoAllowCommands: settings.sandbox.autoAllowCommands !== false,
    autoAllowShellCommands: settings.sandbox.autoAllowShellCommands === true,
    maskSensitivePaths: settings.sandbox.maskSensitivePaths !== false,
    maskedPaths: settings.sandbox.maskSensitivePaths === false ? [] : collectSensitivePaths(),
    writable: backend === 'os' ? writable : [root, ...additionalWritable],
    protectedRoots: settings.sandbox.protectProjectConfig === false ? [] : [root, ...additionalWritable],
    writableCaches: backend === 'os' ? caches : [],
    backend,
    ...(backend === 'ssh' ? { ssh, network: true } : {}),
    ...(backend === 'os' || backend === 'ssh' ? {} : { image: settings.sandbox.image || DEFAULT_CONTAINER_IMAGE, memory: settings.sandbox.memory || '', cpus: settings.sandbox.cpus || '', readOnlyRoot: settings.sandbox.readOnlyRoot === true })
  };
}

function seatbeltString(value) {
  const text = String(value);
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(text)) {
    throw new Error('Sandbox paths cannot contain control characters.');
  }
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function assertSandboxAvailable(sandbox) {
  if (sandbox && sandbox.enabled && !sandbox.available) {
    const reason = String(sandbox.reason || 'No supported OS sandbox is available on this platform.');
    throw new Error('The OS sandbox is enabled but unavailable; refusing to run commands without isolation. ' + reason);
  }
}

function protectedSeatbeltRules(roots) {
  const rules = [];
  for (const root of roots) {
    let base;
    try { base = realpathSync(root); } catch { base = path.resolve(root); }
    const dotGit = lstatOrNull(path.join(base, '.git'));
    for (const rel of PROTECTED_FILES) rules.push('(deny file-write* (literal ' + seatbeltString(path.join(base, ...rel.split('/'))) + '))');
    for (const rel of PROTECTED_DIRS) {
      const full = path.join(base, ...rel.split('/'));
      rules.push('(deny file-write* (literal ' + seatbeltString(full) + ') (subpath ' + seatbeltString(full) + '))');
    }
    if (dotGit && dotGit.isFile()) rules.push('(deny file-write* (literal ' + seatbeltString(path.join(base, '.git')) + '))');
  }
  return rules;
}

export function macProfile(sandbox) {
  const writable = [...sandbox.writable, os.tmpdir(), '/private/tmp', '/private/var/folders'];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    ...((sandbox.maskedPaths || []).map((item) => '(deny file-read* (' + (item.type === 'directory' ? 'subpath ' : 'literal ') + seatbeltString(item.path) + '))')),
    '(allow file-write* ' + writable.map((dir) => '(subpath ' + seatbeltString(dir) + ')').join(' ') + ' (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/tty"))',
    ...protectedSeatbeltRules(sandbox.protectedRoots || []),
    sandbox.network ? '' : '(deny network*) (allow network* (remote unix-socket))'
  ].join('\n');
}

const SENSITIVE_TMP_ENTRY = /^(?:ssh-|\.x11-unix$|\.ice-unix$|\.xim-unix$|\.font-unix$|\.test-unix$|tmux-|systemd-private-|gpg|keyring|pulse-|dbus-|\.com\.google\.chrome|krb5cc|vscode-|com\.apple\.launchd)/i;

function toolchainPrefix(dir) {
  return path.basename(dir) === 'bin' ? path.dirname(dir) : dir;
}

export function tmpToolchainMounts(command, env = process.env) {
  const roots = new Set();
  const consider = (candidate, { file = false } = {}) => {
    if (!candidate || !path.isAbsolute(candidate)) return;
    let real = candidate;
    try { real = realpathSync(candidate); } catch { /* keep the literal path */ }
    for (const value of new Set([path.resolve(candidate), real])) {
      if (!pathContains('/tmp', value) || path.resolve(value) === '/tmp') continue;
      const first = path.relative('/tmp', value).split(path.sep)[0];
      if (SENSITIVE_TMP_ENTRY.test(first)) continue;
      let stats;
      try { stats = statSync(value); } catch { continue; }
      if (file ? !stats.isFile() : !stats.isDirectory()) continue;
      const dir = toolchainPrefix(file ? path.dirname(value) : value);
      if (path.resolve(dir) === '/tmp') continue;
      roots.add(dir);
    }
  };
  consider(command, { file: true });
  for (const entry of String(env.PATH || '').split(path.delimiter)) consider(entry);
  return [...roots].filter((dir) => ![...roots].some((other) => other !== dir && pathContains(other, dir)));
}

export function wrapCommand(command, args, sandbox, cwd, options = {}) {
  assertSandboxAvailable(sandbox);
  if (!sandbox || !sandbox.enabled || !sandbox.available) return { command, args };
  if (sandbox.kind === 'ssh') return sshWrap(command, args, sandbox, cwd, { tty: Boolean(options.tty) });
  if (sandbox.kind === 'bubblewrap') {
    const wrapped = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-pid', '--die-with-parent', '--new-session'];
    for (const dir of tmpToolchainMounts(command)) wrapped.push('--ro-bind', dir, dir);
    for (const dir of sandbox.writable) wrapped.push('--bind', dir, dir);
    for (const item of sandbox.maskedPaths || []) {
      if (item.type === 'directory') wrapped.push('--tmpfs', item.path);
      else if (item.type === 'file') wrapped.push('--ro-bind', '/dev/null', item.path);
    }
    const guarded = protectedWritePaths(sandbox.protectedRoots || []);
    for (const item of guarded.existing) wrapped.push('--ro-bind', item.path, item.path);
    for (const item of guarded.missing) {
      if (item.type === 'directory') wrapped.push('--perms', '0555', '--tmpfs', item.path, '--remount-ro', item.path);
      else wrapped.push('--ro-bind', '/dev/null', item.path);
    }
    if (!sandbox.network) wrapped.push('--unshare-net');
    wrapped.push('--chdir', cwd, '--', command, ...args);
    return { command: 'bwrap', args: wrapped, release: trackPlaceholders(guarded.missing) };
  }
  if (sandbox.kind === 'sandbox-exec') {
    return { command: 'sandbox-exec', args: ['-p', macProfile(sandbox), command, ...args] };
  }
  if (CONTAINER_BACKENDS.includes(sandbox.kind)) {
    return { command: sandbox.kind, args: containerArgs(command, args, sandbox, cwd) };
  }
  if (sandbox.kind === 'srt') throw new Error('The domain-filtering sandbox needs launchCommand (asynchronous).');
  return { command, args };
}

export async function launchCommand(command, args, sandbox, cwd, options = {}) {
  if (sandbox && sandbox.enabled && sandbox.available && sandbox.kind === 'srt') {
    const { srtLaunch } = await import('./sandbox-runtime.mjs');
    return srtLaunch(command, args, sandbox, cwd);
  }
  return wrapCommand(command, args, sandbox, cwd, options);
}
