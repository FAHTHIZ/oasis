// Modal execution backend: commands run in a Modal Sandbox (https://modal.com/docs/guide/sandboxes)
// instead of on this machine. OASIS starts one sandbox per workspace running
// sshd, reaches it through Modal's TCP tunnel with a key it generates, and then
// everything the SSH backend does (rsync workspace sync, background jobs, PTY
// sessions) works unchanged.
//
//   MODAL_TOKEN_ID / MODAL_TOKEN_SECRET (or `modal token new`, which writes ~/.modal.toml)
//   "sandbox": { "enabled": true, "backend": "modal",
//                "modal": { "image": "node:22-bookworm", "timeoutMinutes": 720,
//                           "cpu": 2, "memoryMiB": 4096, "gpu": "T4", "region": "us-east" } }
//
// The sandbox ID, tunnel address, SSH key and known_hosts live in .oasis/modal/
// (mode 0600). Modal sandboxes are temporary: when one reaches its timeout the
// next command starts a fresh one and the workspace is synced again; files
// that only existed in the old sandbox are gone.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ALIAS = 'oasis-modal';
const RECHECK_MS = 5 * 60 * 1000;
const READY_TIMEOUT_MS = 300000;
const DEFAULT_IMAGE = 'node:22-bookworm';
const IMAGE_RE = /^[\w][\w.:\/@-]{0,250}$/;

export function modalCredentialsPresent(env = process.env, home = os.homedir()) {
  if (env.MODAL_TOKEN_ID && env.MODAL_TOKEN_SECRET) return true;
  const file = env.MODAL_CONFIG_PATH || path.join(home, '.modal.toml');
  try { return /token_id\s*=/.test(readFileSync(file, 'utf8')); } catch { return false; }
}

export function normalizeModalSettings(raw = {}, env = process.env, root = process.cwd(), home = os.homedir()) {
  if (!modalCredentialsPresent(env, home)) return { error: 'Set MODAL_TOKEN_ID and MODAL_TOKEN_SECRET (Modal dashboard → Settings → API tokens), or run `modal token new`, to run commands in a Modal sandbox.' };
  const image = String(env.OASIS_MODAL_IMAGE || raw.image || DEFAULT_IMAGE);
  if (!IMAGE_RE.test(image)) return { error: 'modal.image must be a container image name such as node:22-bookworm.' };
  const timeoutMinutes = raw.timeoutMinutes === undefined ? 720 : Number(raw.timeoutMinutes);
  if (!(Number.isInteger(timeoutMinutes) && timeoutMinutes >= 5 && timeoutMinutes <= 1440)) return { error: 'modal.timeoutMinutes must be a whole number from 5 to 1440 (Modal\'s 24-hour limit).' };
  const number = (key, min, max) => raw[key] === undefined ? undefined : Number(raw[key]) >= min && Number(raw[key]) <= max ? Number(raw[key]) : NaN;
  const cpu = number('cpu', 0.125, 64);
  const memoryMiB = number('memoryMiB', 128, 344064);
  if (Number.isNaN(cpu)) return { error: 'modal.cpu must be a number of cores from 0.125 to 64.' };
  if (Number.isNaN(memoryMiB)) return { error: 'modal.memoryMiB must be from 128 to 344064.' };
  const gpu = raw.gpu ? String(raw.gpu) : '';
  if (gpu && !/^[\w:+-]{1,40}$/.test(gpu)) return { error: 'modal.gpu must be a GPU type such as T4, A10G, A100 or H100:2.' };
  const region = raw.region ? String(raw.region) : '';
  if (region && !/^[\w-]{1,40}$/.test(region)) return { error: 'modal.region must be a region name such as us-east.' };
  const appName = String(raw.appName || 'oasis');
  if (!/^[\w.-]{1,64}$/.test(appName)) return { error: 'modal.appName may only use letters, digits, dot, dash and underscore.' };
  const environment = String(env.MODAL_ENVIRONMENT || raw.environment || '');
  const remoteRoot = String(raw.remoteRoot || '/root/workspace').replace(/\/+$/, '');
  if (!/^(?:~|~\/[\w.\/-]*|\/[\w.\/-]*)$/.test(remoteRoot) || remoteRoot.split('/').includes('..')) return { error: 'modal.remoteRoot must be an absolute or ~/ path.' };
  const localRoot = path.resolve(root);
  const stateDir = path.join(localRoot, '.oasis', 'modal');
  return {
    image, timeoutMinutes, cpu, memoryMiB, gpu, region, appName, environment, remoteRoot, localRoot, stateDir,
    setup: Array.isArray(raw.setup) ? raw.setup.map(String).slice(0, 20) : [],
    stateFile: path.join(stateDir, 'state.json'),
    configFile: path.join(stateDir, 'ssh_config'),
    knownHosts: path.join(stateDir, 'known_hosts'),
    keyFile: path.join(stateDir, 'id_ed25519'),
    exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : undefined,
    label: 'oasis-' + createHash('sha256').update(localRoot).digest('hex').slice(0, 12)
  };
}

export function readModalState(modal) {
  try { return JSON.parse(readFileSync(modal.stateFile, 'utf8')); } catch { return null; }
}

function writePrivate(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
}

/** Creates the workspace's SSH key once; returns the public key line. */
export function ensureModalKey(modal, { run = spawnSync } = {}) {
  if (!existsSync(modal.keyFile)) {
    mkdirSync(modal.stateDir, { recursive: true, mode: 0o700 });
    const made = run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', modal.label, '-f', modal.keyFile], { encoding: 'utf8', windowsHide: true });
    if (!made || made.status !== 0) throw new Error('ssh-keygen failed: ' + String(made && (made.stderr || (made.error && made.error.message)) || '').trim().slice(0, 200));
  }
  return readFileSync(modal.keyFile + '.pub', 'utf8').trim();
}

export function sshConfigText(modal, tunnel) {
  const clean = (value) => String(value).replace(/[\s"\\]/g, '');
  const quote = (file) => '"' + file.replace(/"/g, '') + '"';
  return [
    'Host ' + ALIAS,
    '  HostName ' + clean(tunnel.host),
    '  Port ' + Number(tunnel.port),
    '  User root',
    '  IdentityFile ' + quote(modal.keyFile),
    '  IdentitiesOnly yes',
    '  StrictHostKeyChecking accept-new',
    '  UserKnownHostsFile ' + quote(modal.knownHosts),
    '  ServerAliveInterval 30',
    '  LogLevel ERROR',
    ''
  ].join('\n');
}

/** The Dockerfile steps that add sshd and rsync to the image (apt, apk or dnf based). */
export function imageCommands(modal) {
  return [
    'RUN if command -v apt-get >/dev/null; then apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server rsync ca-certificates && rm -rf /var/lib/apt/lists/*; '
      + 'elif command -v apk >/dev/null; then apk add --no-cache openssh-server rsync bash; '
      + 'elif command -v dnf >/dev/null; then dnf install -y openssh-server rsync && dnf clean all; '
      + 'else echo "OASIS needs an apt, apk or dnf based image for the Modal backend" >&2; exit 1; fi',
    'RUN mkdir -p /run/sshd /root/.ssh && chmod 700 /root/.ssh && ssh-keygen -A',
    ...modal.setup.map((line) => /^(RUN|ENV|WORKDIR|ARG|COPY|ADD)\s/i.test(line) ? line : 'RUN ' + line)
  ];
}

export const SSHD_COMMAND = ['/bin/sh', '-c', 'printf "%s\\n" "$OASIS_SSH_PUBLIC_KEY" > /root/.ssh/authorized_keys && chmod 600 /root/.ssh/authorized_keys && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=prohibit-password -o AllowTcpForwarding=no -o X11Forwarding=no'];

async function loadSdk() {
  try { return await import('modal'); }
  catch { throw new Error('The Modal SDK is not installed. Reinstall OASIS with optional dependencies, or run npm install modal in the OASIS folder.'); }
}

/**
 * Make sure the workspace's sandbox is running and the ssh config points at its
 * tunnel. Returns the saved state: { sandboxId, host, port, checkedAt }.
 */
export async function provisionModal(modal, { sdk, now = () => Date.now(), log = () => {} } = {}) {
  const lib = sdk || await loadSdk();
  const client = new lib.ModalClient(modal.environment ? { environment: modal.environment } : {});
  try {
    const state = readModalState(modal) || {};
    let sandbox = null;
    if (state.sandboxId) {
      try {
        sandbox = await client.sandboxes.fromId(state.sandboxId);
        if ((await sandbox.poll()) !== null) sandbox = null;
      } catch { sandbox = null; }
    }
    if (!sandbox) {
      const publicKey = ensureModalKey(modal);
      const app = await client.apps.fromName(modal.appName, { createIfMissing: true, ...(modal.environment ? { environment: modal.environment } : {}) });
      const image = client.images.fromRegistry(modal.image).dockerfileCommands(imageCommands(modal));
      log('starting a Modal sandbox for this workspace (' + modal.image + ')');
      sandbox = await client.sandboxes.create(app, image, {
        command: SSHD_COMMAND,
        env: { OASIS_SSH_PUBLIC_KEY: publicKey },
        unencryptedPorts: [22],
        readinessProbe: lib.Probe.withTcp(22),
        timeoutMs: modal.timeoutMinutes * 60000,
        workdir: '/root',
        tags: { 'oasis-workspace': modal.label },
        ...(modal.cpu ? { cpu: modal.cpu } : {}),
        ...(modal.memoryMiB ? { memoryMiB: modal.memoryMiB } : {}),
        ...(modal.gpu ? { gpu: modal.gpu } : {}),
        ...(modal.region ? { regions: [modal.region] } : {})
      });
      state.sandboxId = sandbox.sandboxId;
      state.startedAt = new Date(now()).toISOString();
      rmSync(modal.knownHosts, { force: true });
      await sandbox.waitUntilReady(READY_TIMEOUT_MS);
    }
    const tunnel = (await sandbox.tunnels(60000))[22];
    const host = tunnel && (tunnel.unencryptedHost || tunnel.host);
    const port = tunnel && (tunnel.unencryptedPort || tunnel.port);
    if (!host || !port) throw new Error('Modal did not return a TCP tunnel for port 22.');
    if (host !== state.host || port !== state.port || !existsSync(modal.configFile)) writePrivate(modal.configFile, sshConfigText(modal, { host, port }));
    Object.assign(state, { host, port, checkedAt: now() });
    writePrivate(modal.stateFile, JSON.stringify(state, null, 2) + '\n');
    return state;
  } finally {
    try { client.close(); } catch { /* already closed */ }
  }
}

/** Synchronous wrapper used while resolving the sandbox: re-checks at most every five minutes. */
export function ensureModalSync(modal, { run = spawnSync, now = Date.now() } = {}) {
  const state = readModalState(modal);
  if (state && state.sandboxId && state.checkedAt && now - state.checkedAt < RECHECK_MS && existsSync(modal.configFile)) return { ok: true, state };
  const result = run(process.execPath, [fileURLToPath(import.meta.url), '--provision'], {
    input: JSON.stringify(modal), encoding: 'utf8', timeout: READY_TIMEOUT_MS + 120000, windowsHide: true, env: process.env
  });
  if (!result || result.status !== 0) return { ok: false, reason: String(result && (result.stderr || (result.error && result.error.message)) || 'Modal provisioning failed.').trim().split('\n').pop().slice(0, 300) };
  return { ok: true, state: readModalState(modal) };
}

/** The SSH backend settings that reach the sandbox through the private config. */
export function modalSshSettings(modal) {
  const state = readModalState(modal);
  return {
    host: ALIAS,
    display: 'Modal sandbox' + (state && state.sandboxId ? ' ' + state.sandboxId.slice(0, 14) : ''),
    remoteRoot: modal.remoteRoot,
    port: null,
    identityFile: '',
    configFile: modal.configFile,
    sync: 'rsync',
    exclude: modal.exclude,
    localRoot: modal.localRoot,
    connectTimeout: 20,
    installRsync: false
  };
}

/** `oasis modal up|status|stop` */
export async function modalCommand(action, modal, { sdk } = {}) {
  if (action === 'up' || action === 'start') { const fresh = await provisionModal(modal, { sdk }); return 'Modal sandbox ' + fresh.sandboxId + ' is running (ssh tunnel ' + fresh.host + ':' + fresh.port + ').'; }
  const state = readModalState(modal);
  if (!state || !state.sandboxId) return 'This workspace has no Modal sandbox yet. It starts on the first command, or with oasis modal up.';
  const lib = sdk || await loadSdk();
  const client = new lib.ModalClient(modal.environment ? { environment: modal.environment } : {});
  try {
    if (action === 'status') {
      let text = 'stopped';
      try { const sandbox = await client.sandboxes.fromId(state.sandboxId); const code = await sandbox.poll(); text = code === null ? 'running' : 'finished (exit ' + code + ')'; } catch (error) { text = 'unknown (' + String(error && error.message || error).slice(0, 120) + ')'; }
      return 'Modal sandbox ' + state.sandboxId + ': ' + text + (state.startedAt ? ', started ' + state.startedAt : '') + '.';
    }
    if (action === 'stop' || action === 'delete') {
      try { await (await client.sandboxes.fromId(state.sandboxId)).terminate(); } catch { /* already gone */ }
      writePrivate(modal.stateFile, '{}\n');
      rmSync(modal.knownHosts, { force: true });
      return 'Stopped Modal sandbox ' + state.sandboxId + '. The next command starts a fresh one; files that were only in the sandbox are gone.';
    }
  } finally {
    try { client.close(); } catch { /* already closed */ }
  }
  throw new Error('Usage: oasis modal up|status|stop');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--provision') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      await provisionModal(JSON.parse(input), { log: (line) => process.stderr.write('[modal] ' + line + '\n') });
      process.exit(0);
    } catch (error) {
      process.stderr.write(String(error && error.message || error).split('\n')[0] + '\n');
      process.exit(1);
    }
  });
}
