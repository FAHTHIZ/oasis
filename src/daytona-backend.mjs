// Daytona execution backend: commands run in a Daytona cloud sandbox
// (https://www.daytona.io) instead of on this machine. OASIS creates the sandbox
// on first use, starts it again when it has auto-stopped, and reaches it over
// Daytona's token-based SSH gateway, so everything the SSH backend does (rsync
// workspace sync, background jobs, PTY sessions) works unchanged.
//
//   DAYTONA_API_KEY=dtn_...   (Dashboard, Keys)
//   "sandbox": { "enabled": true, "backend": "daytona",
//                "daytona": { "snapshot": "daytonaio/sandbox", "target": "us",
//                             "autoStopInterval": 30, "remoteRoot": "~/workspace" } }
//
// The sandbox ID and a 24-hour SSH token are kept in .oasis/daytona/ (mode 0600);
// the token is written to a private ssh config so it never appears in a process
// listing, an approval prompt or the model's context.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_API = 'https://app.daytona.io/api';
const TOKEN_MINUTES = 24 * 60;
const RECHECK_MS = 5 * 60 * 1000;
const READY_TIMEOUT_MS = 180000;
const ALIAS = 'oasis-daytona';
const NAME_RE = /^[\w.:\/@-]{1,200}$/;

export function normalizeDaytonaSettings(raw = {}, env = process.env, root = process.cwd()) {
  const apiKey = String(env.DAYTONA_API_KEY || env.OASIS_DAYTONA_API_KEY || '').trim();
  if (!apiKey) return { error: 'Set DAYTONA_API_KEY to an API key from the Daytona dashboard (Keys) to run commands in a Daytona sandbox.' };
  const apiUrl = String(env.DAYTONA_API_URL || raw.apiUrl || DEFAULT_API).replace(/\/+$/, '');
  if (!/^https:\/\/[^\s/]+/.test(apiUrl) && !/^http:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/|$)/.test(apiUrl)) return { error: 'daytona.apiUrl must be an https:// URL.' };
  const snapshot = raw.snapshot ? String(raw.snapshot) : '';
  if (snapshot && !NAME_RE.test(snapshot)) return { error: 'daytona.snapshot is not a valid snapshot name.' };
  const target = String(env.DAYTONA_TARGET || raw.target || '');
  if (target && !/^[\w-]{1,40}$/.test(target)) return { error: 'daytona.target must be a region name such as us or eu.' };
  const autoStopInterval = raw.autoStopInterval === undefined ? 30 : Number(raw.autoStopInterval);
  if (!(Number.isInteger(autoStopInterval) && autoStopInterval >= 0)) return { error: 'daytona.autoStopInterval must be a whole number of minutes (0 keeps it running).' };
  const remoteRoot = String(raw.remoteRoot || '~/workspace').replace(/\/+$/, '');
  if (!/^(?:~|~\/[\w.\/-]*|\/[\w.\/-]*)$/.test(remoteRoot) || remoteRoot.split('/').includes('..')) return { error: 'daytona.remoteRoot must be an absolute or ~/ path.' };
  const localRoot = path.resolve(root);
  const stateDir = path.join(localRoot, '.oasis', 'daytona');
  return {
    apiKey, apiUrl, snapshot, target, autoStopInterval, remoteRoot, localRoot, stateDir,
    stateFile: path.join(stateDir, 'state.json'),
    configFile: path.join(stateDir, 'ssh_config'),
    knownHosts: path.join(stateDir, 'known_hosts'),
    exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : undefined,
    label: 'oasis-' + createHash('sha256').update(localRoot).digest('hex').slice(0, 12)
  };
}

export function readDaytonaState(daytona) {
  try { return JSON.parse(readFileSync(daytona.stateFile, 'utf8')); } catch { return null; }
}

function writePrivate(file, text) {
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, text, { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch { /* Windows */ }
}

/** "ssh TOKEN@ssh.app.daytona.io" (optionally with -p PORT) -> { user, host, port } */
export function parseSshCommand(command) {
  const words = String(command || '').trim().split(/\s+/);
  const at = words.findIndex((word) => /^[^@\s]+@[\w.-]+$/.test(word));
  if (at < 0) return null;
  const [user, host] = words[at].split('@');
  const portAt = words.indexOf('-p');
  const port = portAt >= 0 ? Number(words[portAt + 1]) : 22;
  return { user, host, port: Number.isInteger(port) && port > 0 ? port : 22 };
}

export function sshConfigText(daytona, access) {
  const clean = (value) => String(value).replace(/[\s"\\]/g, '');
  return [
    'Host ' + ALIAS,
    '  HostName ' + clean(access.host),
    '  User ' + clean(access.user),
    '  Port ' + Number(access.port || 22),
    '  StrictHostKeyChecking accept-new',
    '  UserKnownHostsFile "' + daytona.knownHosts.replace(/"/g, '') + '"',
    '  PreferredAuthentications none,keyboard-interactive,password,publickey',
    '  LogLevel ERROR',
    ''
  ].join('\n');
}

async function api(daytona, method, route, body, fetchImpl) {
  const response = await fetchImpl(daytona.apiUrl + route, {
    method,
    headers: { authorization: 'Bearer ' + daytona.apiKey, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(60000)
  });
  const text = await response.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!response.ok) {
    const error = new Error('Daytona ' + method + ' ' + route.split('?')[0] + ' failed: ' + response.status + ' ' + String(data && (data.message || data.error) || text || '').slice(0, 200));
    error.status = response.status;
    throw error;
  }
  return data;
}

/**
 * Make sure the workspace's sandbox exists, is started and has a fresh SSH token.
 * Returns the saved state: { sandboxId, expiresAt, checkedAt }.
 */
export async function provisionDaytona(daytona, { fetchImpl = globalThis.fetch, now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = () => {} } = {}) {
  const state = readDaytonaState(daytona) || {};
  let sandbox = null;
  if (state.sandboxId) {
    try { sandbox = await api(daytona, 'GET', '/sandbox/' + encodeURIComponent(state.sandboxId), null, fetchImpl); }
    catch (error) { if (error.status !== 404) throw error; }
    if (sandbox && ['destroyed', 'destroying', 'error', 'build_failed'].includes(sandbox.state)) sandbox = null;
  }
  if (!sandbox) {
    log('creating a Daytona sandbox for this workspace');
    sandbox = await api(daytona, 'POST', '/sandbox', {
      name: daytona.label + '-' + now().toString(36),
      labels: { 'oasis-workspace': daytona.label },
      autoStopInterval: daytona.autoStopInterval,
      ...(daytona.snapshot ? { snapshot: daytona.snapshot } : {}),
      ...(daytona.target ? { target: daytona.target } : {})
    }, fetchImpl);
    state.sandboxId = sandbox.id;
    state.expiresAt = 0;
    state.rsync = false;
  }
  const deadline = now() + READY_TIMEOUT_MS;
  while (sandbox.state !== 'started') {
    if (['stopped', 'archived', 'paused'].includes(sandbox.state)) {
      log('starting Daytona sandbox ' + sandbox.id);
      sandbox = await api(daytona, 'POST', '/sandbox/' + encodeURIComponent(sandbox.id) + '/start', null, fetchImpl) || sandbox;
      if (sandbox.state === 'started') break;
    }
    if (['error', 'build_failed', 'destroyed'].includes(sandbox.state)) throw new Error('Daytona sandbox ' + sandbox.id + ' is ' + sandbox.state + (sandbox.errorReason ? ': ' + sandbox.errorReason : '') + '.');
    if (now() > deadline) throw new Error('Daytona sandbox ' + sandbox.id + ' did not start within ' + READY_TIMEOUT_MS / 1000 + 's (state ' + sandbox.state + ').');
    await sleep(2000);
    sandbox = await api(daytona, 'GET', '/sandbox/' + encodeURIComponent(sandbox.id), null, fetchImpl);
  }
  if (!state.expiresAt || Date.parse(state.expiresAt) - now() < 60 * 60 * 1000) {
    const access = await api(daytona, 'POST', '/sandbox/' + encodeURIComponent(sandbox.id) + '/ssh-access?expiresInMinutes=' + TOKEN_MINUTES, null, fetchImpl);
    const target = parseSshCommand(access.sshCommand) || { user: access.token, host: 'ssh.app.daytona.io', port: 22 };
    if (!target.user) throw new Error('Daytona returned no SSH token.');
    writePrivate(daytona.configFile, sshConfigText(daytona, target));
    state.expiresAt = access.expiresAt || new Date(now() + TOKEN_MINUTES * 60000).toISOString();
  }
  state.checkedAt = now();
  writePrivate(daytona.stateFile, JSON.stringify(state, null, 2) + '\n');
  return state;
}

/** Synchronous wrapper used while resolving the sandbox: re-provisions at most every five minutes. */
export function ensureDaytonaSync(daytona, { run = spawnSync, now = Date.now() } = {}) {
  const state = readDaytonaState(daytona);
  const fresh = state && state.sandboxId && state.checkedAt && now - state.checkedAt < RECHECK_MS && Date.parse(state.expiresAt) - now > 60 * 60 * 1000;
  if (fresh) return { ok: true, state };
  const result = run(process.execPath, [fileURLToPath(import.meta.url), '--provision'], {
    input: JSON.stringify(daytona), encoding: 'utf8', timeout: READY_TIMEOUT_MS + 60000, windowsHide: true,
    env: { ...process.env, DAYTONA_API_KEY: daytona.apiKey }
  });
  if (!result || result.status !== 0) return { ok: false, reason: String(result && (result.stderr || (result.error && result.error.message)) || 'Daytona provisioning failed.').trim().split('\n').pop().slice(0, 300) };
  return { ok: true, state: readDaytonaState(daytona) };
}

/** The SSH backend settings that reach the sandbox through the private config. */
export function daytonaSshSettings(daytona) {
  return {
    host: ALIAS,
    display: 'Daytona sandbox' + (readDaytonaState(daytona) && readDaytonaState(daytona).sandboxId ? ' ' + readDaytonaState(daytona).sandboxId.slice(0, 12) : ''),
    remoteRoot: daytona.remoteRoot,
    port: null,
    identityFile: '',
    configFile: daytona.configFile,
    sync: 'rsync',
    exclude: daytona.exclude,
    localRoot: daytona.localRoot,
    connectTimeout: 20,
    installRsync: true
  };
}

/** Stop or delete the workspace's sandbox (`oasis daytona stop|delete`). */
export async function daytonaCommand(action, daytona, { fetchImpl = globalThis.fetch } = {}) {
  const state = readDaytonaState(daytona);
  if (action === 'up' || action === 'start') { const fresh = await provisionDaytona(daytona, { fetchImpl }); return 'Daytona sandbox ' + fresh.sandboxId + ' is running.'; }
  if (!state || !state.sandboxId) return 'This workspace has no Daytona sandbox yet. It is created on the first command, or with oasis daytona up.';
  if (action === 'status') {
    const sandbox = await api(daytona, 'GET', '/sandbox/' + encodeURIComponent(state.sandboxId), null, fetchImpl).catch((error) => ({ state: error.status === 404 ? 'deleted' : 'unknown (' + error.message + ')' }));
    return 'Daytona sandbox ' + state.sandboxId + ': ' + sandbox.state + '.';
  }
  if (action === 'stop') { await api(daytona, 'POST', '/sandbox/' + encodeURIComponent(state.sandboxId) + '/stop', null, fetchImpl); writePrivate(daytona.stateFile, JSON.stringify({ ...state, checkedAt: 0 }, null, 2) + '\n'); return 'Stopped Daytona sandbox ' + state.sandboxId + '. It starts again on the next command.'; }
  if (action === 'delete') {
    await api(daytona, 'DELETE', '/sandbox/' + encodeURIComponent(state.sandboxId), null, fetchImpl).catch((error) => { if (error.status !== 404) throw error; });
    writePrivate(daytona.stateFile, '{}\n');
    writePrivate(daytona.configFile, '');
    return 'Deleted Daytona sandbox ' + state.sandboxId + '. Files that were only in the sandbox are gone.';
  }
  throw new Error('Usage: oasis daytona up|status|stop|delete');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === '--provision') {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', async () => {
    try {
      const daytona = { ...JSON.parse(input), apiKey: process.env.DAYTONA_API_KEY };
      await provisionDaytona(daytona, { log: (line) => process.stderr.write('[daytona] ' + line + '\n') });
      process.exit(0);
    } catch (error) {
      process.stderr.write(error.message + '\n');
      process.exit(1);
    }
  });
}
