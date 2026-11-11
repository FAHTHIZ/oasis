import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { chmod, lstat, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { checkSignedBearerToken, defaultControlSocketPath, isLoopbackHost, loadWsAuth, parseListenUrl, startCodexAppServerWebSocket } from '../src/codex-app-server-ws.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.mjs');
const TOKEN = 'ws-test-token-0123456789abcdef';

async function tmp(t, prefix) {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

// A Codex-style client over one WebSocket: one JSON-RPC message per text frame.
function wsClient(url, { token, decide = () => 'accept' } = {}) {
  const ws = new WebSocket(url, token ? { headers: { authorization: 'Bearer ' + token } } : {});
  let id = 0;
  const waiting = new Map();
  const notes = [];
  const approvals = [];
  const waiters = [];
  ws.on('message', (data) => {
    const text = data.toString();
    assert.ok(!text.includes('\n'), 'one message per frame, no JSONL newline');
    const message = JSON.parse(text);
    if (message.method && Object.hasOwn(message, 'id')) { approvals.push(message); ws.send(JSON.stringify({ id: message.id, result: { decision: decide(message) } })); }
    else if (message.method) { notes.push(message); for (const w of waiters.splice(0)) w(); }
    else if (waiting.has(message.id)) { waiting.get(message.id)(message); waiting.delete(message.id); }
  });
  const opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('unexpected-response', (req, res) => reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode }))); ws.once('error', reject); });
  return {
    ws, notes, approvals, opened,
    call(method, params) { const requestId = ++id; ws.send(JSON.stringify({ id: requestId, method, params })); return new Promise((resolve) => waiting.set(requestId, resolve)); },
    async until(predicate) { while (!notes.some(predicate)) await new Promise((resolve) => waiters.push(resolve)); return notes.find(predicate); },
    close() { ws.close(); }
  };
}

test('listen URLs, loopback detection and token auth flags', async (t) => {
  assert.deepEqual(parseListenUrl('stdio://'), { transport: 'stdio' });
  assert.deepEqual(parseListenUrl('ws://127.0.0.1:4500'), { transport: 'ws', host: '127.0.0.1', port: 4500 });
  assert.deepEqual(parseListenUrl('ws://[::1]:4500'), { transport: 'ws', host: '::1', port: 4500 });
  assert.throws(() => parseListenUrl('wss://127.0.0.1:4500'), /TLS/);
  assert.throws(() => parseListenUrl('ws://127.0.0.1'), /host and port/);
  assert.throws(() => parseListenUrl('ws://127.0.0.1:4500/path'), /no path/);
  assert.ok(isLoopbackHost('127.0.0.1') && isLoopbackHost('::1') && isLoopbackHost('localhost'));
  assert.ok(!isLoopbackHost('0.0.0.0') && !isLoopbackHost('192.168.1.5'));
  await assert.rejects(startCodexAppServerWebSocket({ host: '0.0.0.0', port: 0 }), /without auth/);

  const dir = await tmp(t, 'oasis-ws-auth-');
  const file = path.join(dir, 'token');
  await writeFile(file, TOKEN + '\n');
  if (process.platform !== 'win32') {
    await chmod(file, 0o644);
    await assert.rejects(loadWsAuth({ mode: 'capability-token', tokenFile: file }), /chmod 600/);
  }
  await chmod(file, 0o600);
  const fromFile = await loadWsAuth({ mode: 'capability-token', tokenFile: file });
  assert.equal(fromFile('Bearer ' + TOKEN), true);
  assert.equal(fromFile('Bearer wrong-token-0123456789'), false);
  assert.equal(fromFile(''), false);
  const fromHash = await loadWsAuth({ mode: 'capability-token', tokenSha256: createHash('sha256').update(TOKEN).digest('hex') });
  assert.equal(fromHash('bearer ' + TOKEN), true);
  assert.equal(await loadWsAuth({}), null);
  await assert.rejects(loadWsAuth({ mode: 'capability-token' }), /exactly one/);
  await assert.rejects(loadWsAuth({ mode: 'capability-token', tokenFile: 'relative' }), /absolute/);
  await assert.rejects(loadWsAuth({ mode: 'signed-bearer-token' }), /--ws-shared-secret-file/);
  await assert.rejects(loadWsAuth({ tokenSha256: 'ab' }), /need --ws-auth/);
});

function signJwt(claims, secret, header = { alg: 'HS256', typ: 'JWT' }) {
  const enc = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const body = enc(header) + '.' + enc(claims);
  return body + '.' + createHmac('sha256', secret).update(body).digest('base64url');
}

test('signed bearer tokens: HS256 JWT checks match Codex (exp, nbf, iss, aud, clock skew, secret rules)', async (t) => {
  const SECRET = 'shared-secret-for-tests-0123456789abcdef';
  const now = 1_800_000_000;
  const opts = { secret: Buffer.from(SECRET), now };
  assert.equal(checkSignedBearerToken(signJwt({ exp: now + 60 }, SECRET), opts), null);
  assert.equal(checkSignedBearerToken(signJwt({ exp: now + 60 }, 'another-secret-0123456789abcdefghij'), opts), 'invalid websocket jwt');
  assert.equal(checkSignedBearerToken(signJwt({ exp: now + 60 }, SECRET, { alg: 'none' }), opts), 'invalid websocket jwt');
  assert.equal(checkSignedBearerToken(signJwt({ exp: now + 60 }, SECRET, { alg: 'HS512' }), opts), 'invalid websocket jwt');
  assert.equal(checkSignedBearerToken(signJwt({ sub: 'no-exp' }, SECRET), opts), 'invalid websocket jwt');
  assert.equal(checkSignedBearerToken('not.a.jwt', opts), 'invalid websocket jwt');
  assert.equal(checkSignedBearerToken('two.parts', opts), 'invalid websocket jwt');
  const unsigned = signJwt({ exp: now + 60 }, SECRET).split('.').slice(0, 2).join('.') + '.';
  assert.equal(checkSignedBearerToken(unsigned, opts), 'invalid websocket jwt');
  // Expiry and not-before allow 30 seconds of clock skew by default.
  assert.equal(checkSignedBearerToken(signJwt({ exp: now - 30 }, SECRET), opts), null);
  assert.equal(checkSignedBearerToken(signJwt({ exp: now - 31 }, SECRET), opts), 'expired websocket jwt');
  assert.equal(checkSignedBearerToken(signJwt({ exp: now - 31 }, SECRET), { ...opts, maxClockSkewSeconds: 0 }), 'expired websocket jwt');
  assert.equal(checkSignedBearerToken(signJwt({ exp: now + 600, nbf: now + 30 }, SECRET), opts), null);
  assert.equal(checkSignedBearerToken(signJwt({ exp: now + 600, nbf: now + 31 }, SECRET), opts), 'websocket jwt is not valid yet');
  // Issuer and audience are only checked when configured; aud may be a list.
  const pinned = { ...opts, issuer: 'oasis-tests', audience: 'app-server' };
  assert.equal(checkSignedBearerToken(signJwt({ exp: now + 60, iss: 'oasis-tests', aud: 'app-server' }, SECRET), pinned), null);
  assert.equal(checkSignedBearerToken(signJwt({ exp: now + 60, iss: 'oasis-tests', aud: ['other', 'app-server'] }, SECRET), pinned), null);
  assert.equal(checkSignedBearerToken(signJwt({ exp: now + 60, iss: 'elsewhere', aud: 'app-server' }, SECRET), pinned), 'websocket jwt issuer mismatch');
  assert.equal(checkSignedBearerToken(signJwt({ exp: now + 60, iss: 'oasis-tests' }, SECRET), pinned), 'websocket jwt audience mismatch');

  const dir = await tmp(t, 'oasis-ws-jwt-');
  const secretFile = path.join(dir, 'secret');
  await writeFile(secretFile, 'too-short\n', { mode: 0o600 });
  await chmod(secretFile, 0o600);
  await assert.rejects(loadWsAuth({ mode: 'signed-bearer-token', sharedSecretFile: secretFile }), /at least 32 bytes/);
  await writeFile(secretFile, SECRET + '\n');
  if (process.platform !== 'win32') {
    await chmod(secretFile, 0o644);
    await assert.rejects(loadWsAuth({ mode: 'signed-bearer-token', sharedSecretFile: secretFile }), /chmod 600/);
    await chmod(secretFile, 0o600);
  }
  await assert.rejects(loadWsAuth({ mode: 'signed-bearer-token', sharedSecretFile: 'relative' }), /absolute/);
  await assert.rejects(loadWsAuth({ mode: 'signed-bearer-token', sharedSecretFile: secretFile, tokenFile: secretFile }), /not signed-bearer-token/);
  await assert.rejects(loadWsAuth({ mode: 'signed-bearer-token', sharedSecretFile: secretFile, maxClockSkewSeconds: '-5' }), /whole number/);
  await assert.rejects(loadWsAuth({ mode: 'capability-token', tokenFile: secretFile, issuer: 'x' }), /need --ws-auth signed-bearer-token/);
  await assert.rejects(loadWsAuth({ audience: 'x' }), /need --ws-auth signed-bearer-token/);
  const verify = await loadWsAuth({ mode: 'signed-bearer-token', sharedSecretFile: secretFile, issuer: 'oasis-tests' });
  const live = Math.floor(Date.now() / 1000);
  assert.equal(verify('Bearer ' + signJwt({ exp: live + 60, iss: 'oasis-tests' }, SECRET)), true);
  assert.equal(verify('Bearer ' + signJwt({ exp: live + 60 }, SECRET)), false);
  assert.equal(verify(signJwt({ exp: live + 60, iss: 'oasis-tests' }, SECRET)), false);

  // End to end: the listener refuses a bad JWT before any JSON-RPC and accepts a good one.
  const listener = await startCodexAppServerWebSocket({ host: '127.0.0.1', port: 0, verify, log: () => {}, env: { ...process.env, HOME: dir, OASIS_CONFIG_DIR: path.join(dir, 'cfg') }, version: 'test' });
  t.after(() => listener.close());
  const open = (token) => new Promise((resolve) => {
    const ws = new WebSocket(listener.url, { headers: { authorization: 'Bearer ' + token } });
    ws.once('open', () => { ws.close(); resolve('open'); });
    ws.once('unexpected-response', (req, res) => resolve(res.statusCode));
    ws.once('error', () => {});
  });
  assert.equal(await open(signJwt({ exp: live - 120, iss: 'oasis-tests' }, SECRET)), 401);
  assert.equal(await open(signJwt({ exp: live + 60, iss: 'oasis-tests' }, 'wrong-secret-0123456789abcdefghijkl')), 401);
  assert.equal(await open(signJwt({ exp: live + 60, iss: 'oasis-tests' }, SECRET)), 'open');
});

test('oasis app-server --listen ws://: health probes, Origin and token checks, a full turn with an approval, independent connections', async (t) => {
  const root = await tmp(t, 'oasis-ws-root-');
  const home = await tmp(t, 'oasis-ws-home-');
  const tokenFile = path.join(home, 'token');
  await writeFile(tokenFile, TOKEN, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
  const { config } = await scriptedModel(t, [
    toolCall('call_cmd', 'run_command', { command: process.execPath, args: ['-e', 'console.log("over websocket")'] }),
    { content: 'Ran it over the socket.' }
  ]);
  const child = spawn(process.execPath, [CLI, 'app-server', '--listen', 'ws://127.0.0.1:0', '--ws-auth', 'capability-token', '--ws-token-file', tokenFile], {
    cwd: root,
    env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: config.baseURL, OASIS_MODEL: 'fixture', OASIS_API_KEY: '', OASIS_SANDBOX: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  let stderr = '';
  const url = await new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => { stderr += chunk; const m = /listening on (ws:\/\/\S+)/.exec(stderr); if (m) resolve(m[1]); });
    child.once('exit', (code) => reject(new Error('exited ' + code + ': ' + stderr)));
  });
  assert.match(stderr, /bearer token required/);
  const http = url.replace(/^ws:/, 'http:');
  assert.equal((await fetch(http + '/readyz')).status, 200);
  assert.equal((await fetch(http + '/healthz')).status, 200);
  assert.equal((await fetch(http + '/healthz', { headers: { origin: 'https://evil.example' } })).status, 403);

  const anonymous = wsClient(url);
  await assert.rejects(anonymous.opened, (error) => error.status === 401);
  const wrong = wsClient(url, { token: 'not-the-token-0123456789' });
  await assert.rejects(wrong.opened, (error) => error.status === 401);
  const fromPage = new WebSocket(url, { headers: { authorization: 'Bearer ' + TOKEN, origin: 'https://evil.example' } });
  await assert.rejects(new Promise((resolve, reject) => { fromPage.once('open', resolve); fromPage.once('unexpected-response', (req, res) => reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode }))); }), (error) => error.status === 403);

  const client = wsClient(url, { token: TOKEN });
  await client.opened;
  const init = await client.call('initialize', { clientInfo: { name: 'ws_test', version: '1' } });
  assert.match(init.result.userAgent, /^oasis\//);
  // A second connection has its own protocol state.
  const other = wsClient(url, { token: TOKEN });
  await other.opened;
  assert.equal((await other.call('thread/start', { cwd: root })).error.message, 'Not initialized');
  other.close();

  const started = await client.call('thread/start', { cwd: root, approvalPolicy: 'on-request' });
  assert.ok(started.result, stderr + JSON.stringify(started));
  const turn = await client.call('turn/start', { threadId: started.result.thread.id, input: [{ type: 'text', text: 'run it' }] });
  assert.equal(turn.result.turn.status, 'inProgress');
  const done = await client.until((note) => note.method === 'turn/completed');
  assert.equal(done.params.turn.status, 'completed', stderr + JSON.stringify(done));
  assert.equal(client.approvals[0].method, 'item/commandExecution/requestApproval');
  const items = client.notes.filter((note) => note.method === 'item/completed').map((note) => note.params.item);
  const command = items.find((item) => item.type === 'commandExecution');
  assert.equal(command.exitCode, 0);
  assert.match(command.aggregatedOutput, /over websocket/);
  assert.equal(items.find((item) => item.type === 'agentMessage').text, 'Ran it over the socket.');
  client.close();

  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.kill('SIGTERM');
  assert.deepEqual(await exited, { code: 0, signal: null });
});

test('--listen unix://: private socket, Codex-style default path, stale socket cleanup, live socket refused', { skip: process.platform === 'win32' }, async (t) => {
  const env = { HOME: '/home/someone' };
  assert.deepEqual(parseListenUrl('unix://', { env }), { transport: 'unix', socketPath: '/home/someone/.oasis/app-server-control/app-server-control.sock', defaultPath: true });
  assert.equal(defaultControlSocketPath({ OASIS_CONFIG_DIR: '/cfg' }), '/cfg/app-server-control/app-server-control.sock');
  assert.deepEqual(parseListenUrl('unix://run/as.sock', { cwd: '/work' }), { transport: 'unix', socketPath: '/work/run/as.sock', defaultPath: false });
  assert.throws(() => parseListenUrl('unix:///' + 'x'.repeat(120)), /too long/);

  const dir = await tmp(t, 'oasis-as-unix-');
  const socketDir = path.join(dir, 'ctl');
  const socketPath = path.join(socketDir, 's.sock');
  const listener = await startCodexAppServerWebSocket({ socketPath, env: process.env, version: '0.0.0-test' });
  t.after(() => listener.close());
  assert.equal(listener.url, 'unix://' + socketPath);
  assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
  assert.equal((await stat(socketDir)).mode & 0o777, 0o700);

  const client = wsClient('ws+unix://' + socketPath + ':/');
  await client.opened;
  const init = await client.call('initialize', { clientInfo: { name: 'unix_test', version: '1' } });
  assert.match(init.result.userAgent, /^oasis\//);
  client.close();

  // A second server on the same live socket is refused rather than stealing it.
  await assert.rejects(startCodexAppServerWebSocket({ socketPath, env: process.env }), /already listening/);
  await listener.close();
  await assert.rejects(lstat(socketPath), { code: 'ENOENT' });

  // A stale socket (no listener) is removed; a regular file is left alone.
  const stalePath = path.join(socketDir, 'stale.sock');
  const holder = spawn(process.execPath, ['-e', 'require("net").createServer().listen(process.argv[1], () => console.log("up"))', stalePath], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve) => holder.stdout.once('data', resolve));
  const killed = new Promise((resolve) => holder.once('exit', resolve));
  holder.kill('SIGKILL');
  await killed;
  assert.equal((await lstat(stalePath)).isSocket(), true, 'SIGKILL leaves the socket file behind');
  const again = await startCodexAppServerWebSocket({ socketPath: stalePath, env: process.env });
  assert.equal(again.url, 'unix://' + stalePath);
  await again.close();
  const filePath = path.join(socketDir, 'plain');
  await writeFile(filePath, 'not a socket');
  await assert.rejects(startCodexAppServerWebSocket({ socketPath: filePath, env: process.env }), /not a socket/);
  assert.equal((await stat(filePath)).isFile(), true);
});
