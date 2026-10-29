// Optional OS-level sandbox for agent-run commands.
//
// Linux: bubblewrap (bwrap). The host filesystem is mounted read-only, the
//   workspace (and configured extra directories) are writable, /tmp is a private
//   tmpfs, PID namespace is isolated, and network is unshared unless enabled.
//   Common host credential paths are masked when detected; this is defense in depth,
//   not complete filesystem-read isolation.
// macOS: sandbox-exec with a profile that denies file writes outside the
//   workspace and temp folders and, unless enabled, denies network access.
// Other platforms report the sandbox as unavailable; Oasis then falls back to
// approvals. Enable with settings { "sandbox": { "enabled": true } } or OASIS_SANDBOX=1.
import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SENSITIVE_HOME_PATHS = [
  '.ssh', '.aws', '.azure', '.kube', '.docker', '.gnupg',
  '.claude', '.codex', '.netrc', '.npmrc', '.git-credentials', '.pgpass',
  path.join('.config', 'gcloud'), path.join('.config', 'gh'), path.join('.config', 'oasis')
];

function pathContains(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

export function collectSensitivePaths(explicitWritable = [], env = process.env) {
  const home = path.resolve(env.HOME || os.homedir());
  const configPath = path.resolve(env.OASIS_CONFIG_DIR || env.OASIS_HOME || path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'oasis'));
  const candidates = [...SENSITIVE_HOME_PATHS.map((item) => path.join(home, item)), configPath];
  // Do not treat the workspace root itself as an explicit credential-access grant.
  // A workspace can be the home directory; its broad write mount must not disable
  // masking of ~/.ssh, ~/.aws, and other credential locations.
  const explicitlyWritablePaths = explicitWritable.map((item) => path.resolve(item));
  const masked = [];
  for (const candidate of candidates) {
    let real;
    let info;
    try { real = realpathSync(candidate); info = statSync(real); } catch { continue; }
    const type = info.isDirectory() ? 'directory' : info.isFile() ? 'file' : null;
    // Only an explicit grant that contains the sensitive path can opt it out of
    // masking. A writable child inside a credential directory does not expose the
    // entire credential directory.
    if (!type || explicitlyWritablePaths.some((item) => pathContains(item, real))) continue;
    if (masked.some((item) => pathContains(item.path, real))) continue;
    masked.push({ path: real, type });
  }
  return masked;
}

let cachedProbe = null;

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

export function resolveSandbox(settings = {}, root, force = false) {
  const wanted = settings.sandbox && settings.sandbox.enabled;
  if (!wanted) return { enabled: false, available: false, kind: 'none' };
  const probe = detectSandbox(force);
  const additionalWritable = ((settings.permissions && settings.permissions.additionalDirectories) || []).map((dir) => path.resolve(root, dir));
  const writable = [root, ...additionalWritable];
  return {
    enabled: true,
    available: probe.available,
    kind: probe.kind,
    reason: probe.reason,
    network: Boolean(settings.sandbox.network),
    autoAllowCommands: settings.sandbox.autoAllowCommands !== false,
    maskSensitivePaths: settings.sandbox.maskSensitivePaths !== false,
    maskedPaths: settings.sandbox.maskSensitivePaths === false ? [] : collectSensitivePaths(additionalWritable),
    writable
  };
}

function seatbeltString(value) {
  const text = String(value);
  // Paths are embedded in SBPL source. Control characters (especially CR/LF)
  // could terminate a quoted literal and inject additional policy expressions.
  // Refuse ambiguous paths rather than trying to escape profile-language syntax.
  if (/[\u0000-\u001f\u007f\u2028\u2029]/u.test(text)) {
    throw new Error('Sandbox paths cannot contain control characters.');
  }
  return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function macProfile(sandbox) {
  const writable = [...sandbox.writable, os.tmpdir(), '/private/tmp', '/private/var/folders'];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    ...((sandbox.maskedPaths || []).map((item) => '(deny file-read* (' + (item.type === 'directory' ? 'subpath ' : 'literal ') + seatbeltString(item.path) + '))')),
    '(allow file-write* ' + writable.map((dir) => '(subpath ' + seatbeltString(dir) + ')').join(' ') + ' (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/tty"))',
    sandbox.network ? '' : '(deny network*) (allow network* (remote unix-socket))'
  ].join('\n');
}

// Returns { command, args } that runs the requested argv inside the sandbox.
export function wrapCommand(command, args, sandbox, cwd) {
  if (!sandbox || !sandbox.enabled || !sandbox.available) return { command, args };
  if (sandbox.kind === 'bubblewrap') {
    const wrapped = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-pid', '--die-with-parent', '--new-session'];
    // Apply writable workspace mounts first, then overlay credential masks. If the
    // workspace is the user's home directory, the later masks must remain visible
    // instead of being hidden underneath the broad writable bind.
    for (const dir of sandbox.writable) wrapped.push('--bind', dir, dir);
    for (const item of sandbox.maskedPaths || []) {
      if (item.type === 'directory') wrapped.push('--tmpfs', item.path);
      else if (item.type === 'file') wrapped.push('--ro-bind', '/dev/null', item.path);
    }
    if (!sandbox.network) wrapped.push('--unshare-net');
    wrapped.push('--chdir', cwd, '--', command, ...args);
    return { command: 'bwrap', args: wrapped };
  }
  if (sandbox.kind === 'sandbox-exec') {
    return { command: 'sandbox-exec', args: ['-p', macProfile(sandbox), command, ...args] };
  }
  return { command, args };
}
