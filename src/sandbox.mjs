// Optional OS-level sandbox for agent-run commands.
//
// Linux: bubblewrap (bwrap). The host filesystem is mounted read-only, the
//   workspace (and configured extra directories) are writable, /tmp is a private
//   tmpfs, PID namespace is isolated, and the network is unshared unless enabled.
// macOS: sandbox-exec with a profile that denies file writes outside the
//   workspace and temp folders and, unless enabled, denies network access.
// Other platforms report the sandbox as unavailable; Oasis then falls back to
// approvals. Enable with settings { "sandbox": { "enabled": true } } or OASIS_SANDBOX=1.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

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
  return {
    enabled: true,
    available: probe.available,
    kind: probe.kind,
    reason: probe.reason,
    network: Boolean(settings.sandbox.network),
    autoAllowCommands: settings.sandbox.autoAllowCommands !== false,
    writable: [root, ...((settings.permissions && settings.permissions.additionalDirectories) || []).map((dir) => path.resolve(root, dir))]
  };
}

function seatbeltString(value) {
  return '"' + String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

export function macProfile(sandbox) {
  const writable = [...sandbox.writable, os.tmpdir(), '/private/tmp', '/private/var/folders'];
  return [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    '(allow file-write* ' + writable.map((dir) => '(subpath ' + seatbeltString(dir) + ')').join(' ') + ' (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr") (regex #"^/dev/tty"))',
    sandbox.network ? '' : '(deny network*) (allow network* (remote unix-socket))'
  ].join('\n');
}

// Returns { command, args } that runs the requested argv inside the sandbox.
export function wrapCommand(command, args, sandbox, cwd) {
  if (!sandbox || !sandbox.enabled || !sandbox.available) return { command, args };
  if (sandbox.kind === 'bubblewrap') {
    const wrapped = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--unshare-pid', '--die-with-parent', '--new-session'];
    for (const dir of sandbox.writable) wrapped.push('--bind', dir, dir);
    if (!sandbox.network) wrapped.push('--unshare-net');
    wrapped.push('--chdir', cwd, '--', command, ...args);
    return { command: 'bwrap', args: wrapped };
  }
  if (sandbox.kind === 'sandbox-exec') {
    return { command: 'sandbox-exec', args: ['-p', macProfile(sandbox), command, ...args] };
  }
  return { command, args };
}
