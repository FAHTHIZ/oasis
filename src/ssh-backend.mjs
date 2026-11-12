// SSH execution backend: run_command, run_shell, background jobs and PTY sessions run
// on a remote machine (a bigger box, a GPU server, a disposable VM) instead of here.
//
//   "sandbox": { "enabled": true, "backend": "ssh",
//                "ssh": { "host": "me@gpu-box", "remoteRoot": "~/work/app", "port": 22,
//                         "identityFile": "~/.ssh/id_ed25519", "sync": "rsync",
//                         "exclude": ["node_modules/", ".venv/"] } }
//
// With sync "rsync" (default) the workspace is pushed with rsync before every command
// (--delete, excluded paths untouched) and files the command changed are pulled back
// afterwards (--update, so a newer local file is never overwritten; remote deletions are
// not mirrored). With sync "none" the remote directory is used as is (shared disk,
// sshfs, or a checkout you manage). File tools still read and edit the local copy.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';

const DEFAULT_SSH_EXCLUDES = ['node_modules/', '.venv/', 'venv/', '__pycache__/', '.mypy_cache/', '.pytest_cache/', '.tox/', 'target/', '.gradle/', '.next/cache/', '.oasis/sessions/'];
const HOST_RE = /^(?:[A-Za-z0-9._-]+@)?(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\])$/;
const REMOTE_PATH_RE = /^(?:~|~\/[\w.\/-]*|\/[\w.\/-]*)$/;
const EXCLUDE_RE = /^[\w.*?\/\[\]-]{1,200}$/;

export function shellQuote(value) {
  const text = String(value);
  if (/^[\w.\/:=@%+,-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

// "~/x" -> "$HOME"/x so the remote shell expands it; other paths are quoted.
function remoteShellPath(remotePath) {
  if (remotePath === '~') return '"$HOME"';
  if (remotePath.startsWith('~/')) return '"$HOME"/' + shellQuote(remotePath.slice(2) || '.');
  return shellQuote(remotePath);
}

export function normalizeSshSettings(raw = {}, env = process.env, root = process.cwd()) {
  const host = String(env.OASIS_SSH_HOST || raw.host || '').trim();
  if (!host) return { error: 'Set the SSH host: "sandbox": { "backend": "ssh", "ssh": { "host": "user@machine" } } or OASIS_SSH_HOST.' };
  if (!HOST_RE.test(host) || host.startsWith('-')) return { error: 'The SSH host "' + host.slice(0, 80) + '" is not valid. Use user@hostname or a Host alias from ~/.ssh/config.' };
  const fallback = '~/oasis-workspaces/' + path.basename(path.resolve(root)).replace(/[^\w.-]/g, '_') + '-' + createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 8);
  const remoteRoot = String(env.OASIS_SSH_REMOTE_ROOT || raw.remoteRoot || fallback).replace(/\/+$/, '') || '/';
  if (!REMOTE_PATH_RE.test(remoteRoot) || remoteRoot.split('/').includes('..')) return { error: 'remoteRoot must be an absolute or ~/ path made of letters, digits, ".", "_", "-" and "/".' };
  const port = raw.port === undefined || raw.port === '' ? (env.OASIS_SSH_PORT ? Number(env.OASIS_SSH_PORT) : null) : Number(raw.port);
  if (port !== null && !(Number.isInteger(port) && port > 0 && port < 65536)) return { error: 'The SSH port must be a number between 1 and 65535.' };
  const identityFile = raw.identityFile ? String(raw.identityFile) : '';
  if (identityFile && (/[\u0000-\u001f]/.test(identityFile) || identityFile.startsWith('-'))) return { error: 'identityFile is not a valid path.' };
  const sync = String(env.OASIS_SSH_SYNC || raw.sync || 'rsync');
  if (!['rsync', 'none'].includes(sync)) return { error: 'ssh.sync must be "rsync" or "none".' };
  const exclude = Array.isArray(raw.exclude) ? raw.exclude.map(String) : DEFAULT_SSH_EXCLUDES;
  const bad = exclude.find((item) => !EXCLUDE_RE.test(item) || item.startsWith('-'));
  if (bad) return { error: 'ssh.exclude entry "' + bad.slice(0, 80) + '" is not a valid rsync pattern.' };
  return { host, remoteRoot, port, identityFile, sync, exclude, localRoot: path.resolve(root), connectTimeout: Number(raw.connectTimeout) > 0 ? Math.min(120, Number(raw.connectTimeout)) : 15 };
}

function sshOptions(ssh, { tty = false } = {}) {
  const options = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=' + ssh.connectTimeout, '-o', 'ServerAliveInterval=30'];
  if (ssh.port) options.push('-p', String(ssh.port));
  if (ssh.identityFile) options.push('-i', ssh.identityFile, '-o', 'IdentitiesOnly=yes');
  options.push(tty ? '-tt' : '-T');
  return options;
}

function remoteWorkdir(ssh, cwd) {
  const relative = path.relative(ssh.localRoot, path.resolve(cwd || ssh.localRoot));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return ssh.remoteRoot;
  return ssh.remoteRoot.replace(/\/$/, '') + '/' + relative.split(path.sep).join('/');
}

export function remoteCommandLine(command, args, ssh, cwd) {
  const dir = remoteShellPath(remoteWorkdir(ssh, cwd));
  return 'cd ' + dir + ' && CI=1 OASIS_SANDBOXED=1 exec ' + [command, ...args].map(shellQuote).join(' ');
}

function rsyncShell(ssh) {
  return ['ssh', ...sshOptions(ssh).filter((item) => item !== '-T')].map(shellQuote).join(' ');
}

// Returns { command, args } for spawn.
export function sshWrap(command, args, sandbox, cwd, { tty = false, platform = process.platform } = {}) {
  const ssh = sandbox.ssh;
  const remote = remoteCommandLine(command, args, ssh, cwd);
  if (ssh.sync !== 'rsync') return { command: 'ssh', args: [...sshOptions(ssh, { tty }), ssh.host, remote] };
  if (platform === 'win32') throw new Error('ssh sync "rsync" needs a POSIX shell; on Windows use "sync": "none" or WSL.');
  const excludes = ssh.exclude.map((item) => '--exclude=' + shellQuote(item)).join(' ');
  const remoteRsyncPath = shellQuote(ssh.host + ':' + ssh.remoteRoot.replace(/\/?$/, '/'));
  const local = shellQuote(ssh.localRoot.replace(/\/?$/, '/'));
  const sshCmd = ['ssh', ...sshOptions(ssh)].map(shellQuote).join(' ');
  const script = [
    sshCmd + ' ' + shellQuote(ssh.host) + ' ' + shellQuote('mkdir -p ' + remoteShellPath(ssh.remoteRoot)) + ' || exit 255',
    'rsync -az --delete ' + excludes + ' -e ' + shellQuote(rsyncShell(ssh)) + ' ' + local + ' ' + remoteRsyncPath + ' || { echo "oasis: rsync to ' + ssh.host.replace(/["$`\\]/g, '') + ' failed" >&2; exit 255; }',
    ['ssh', ...sshOptions(ssh, { tty })].map(shellQuote).join(' ') + ' ' + shellQuote(ssh.host) + ' ' + shellQuote(remote),
    'rc=$?',
    'rsync -az --update ' + excludes + ' -e ' + shellQuote(rsyncShell(ssh)) + ' ' + remoteRsyncPath + ' ' + local + ' || echo "oasis: could not copy changed files back from the remote host" >&2',
    'exit $rc'
  ].join('\n');
  return { command: '/bin/sh', args: ['-c', script] };
}

const probes = new Map();
export function detectSshRuntime(ssh, force = false, run = spawnSync) {
  if (!ssh || ssh.error) return { available: false, kind: 'none', reason: ssh && ssh.error || 'SSH backend is not configured.' };
  const key = JSON.stringify([ssh.host, ssh.port, ssh.identityFile, ssh.sync]);
  if (probes.has(key) && !force) return probes.get(key);
  let probe;
  try {
    if (ssh.sync === 'rsync') {
      const local = run('rsync', ['--version'], { timeout: 5000, encoding: 'utf8', windowsHide: true });
      if (!local || local.status !== 0) throw Object.assign(new Error('rsync is not installed here. Install rsync, or set "sync": "none".'), { soft: true });
    }
    const result = run('ssh', [...sshOptions(ssh), ssh.host, ssh.sync === 'rsync' ? 'command -v rsync >/dev/null || { echo "rsync is not installed on the remote host" >&2; exit 3; }' : 'true'], { timeout: (ssh.connectTimeout + 10) * 1000, encoding: 'utf8', windowsHide: true });
    if (result && result.error && result.error.code === 'ENOENT') throw Object.assign(new Error('ssh is not installed. Install OpenSSH.'), { soft: true });
    probe = result && result.status === 0
      ? { available: true, kind: 'ssh' }
      : { available: false, kind: 'none', reason: 'Cannot run commands on ' + ssh.host + ' over SSH' + (result && result.stderr ? ': ' + String(result.stderr).trim().split('\n').pop().slice(0, 200) : '.') + ' Check that key-based login works (ssh ' + ssh.host + ' true) without a password prompt.' };
  } catch (error) {
    probe = { available: false, kind: 'none', reason: error.soft ? error.message : 'SSH check failed: ' + error.message };
  }
  probes.set(key, probe);
  return probe;
}
