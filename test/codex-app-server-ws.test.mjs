import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { isLoopbackHost, loadWsAuth, parseListenUrl, startCodexAppServerWebSocket } from '../src/codex-app-server-ws.mjs';
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
  await assert.rejects(loadWsAuth({ mode: 'signed-bearer-token' }), /not supported/);
  await assert.rejects(loadWsAuth({ tokenSha256: 'ab' }), /need --ws-auth/);
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
