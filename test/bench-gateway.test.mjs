import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { completionsUrl, createGateway, parseGatewayArgs, usageFrom } from '../scripts/bench-gateway.mjs';

test('gateway args are validated', () => {
  assert.throws(() => parseGatewayArgs(['--model', 'm']), /upstream/);
  assert.throws(() => parseGatewayArgs(['--upstream', 'ftp://x', '--model', 'm']), /upstream/);
  assert.throws(() => parseGatewayArgs(['--upstream', 'https://x']), /model/);
  const parsed = parseGatewayArgs(['--upstream', 'https://x/v1/', '--model', 'm', '--min-interval-ms', '500']);
  assert.equal(parsed.upstream, 'https://x/v1');
  assert.equal(parsed.minIntervalMs, 500);
  assert.equal(completionsUrl('https://x/v1'), 'https://x/v1/chat/completions');
  assert.equal(completionsUrl('https://text.example/openai'), 'https://text.example/openai');
});

test('usage is read from JSON bodies and SSE streams', () => {
  assert.deepEqual(usageFrom('{"usage":{"prompt_tokens":3,"completion_tokens":2}}'), { prompt_tokens: 3, completion_tokens: 2 });
  const sse = 'data: {"choices":[]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\ndata: [DONE]\n';
  assert.deepEqual(usageFrom(sse), { prompt_tokens: 9, completion_tokens: 4 });
  assert.equal(usageFrom('not json'), null);
});

test('gateway forces the model, serializes and spaces requests, and logs usage', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-gw-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'log.jsonl');
  const seen = [];
  let clock = 1000;
  const waits = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    seen.push({ url, model: body.model, at: clock });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const server = createGateway({ upstream: 'https://up.example/v1', model: 'forced', minIntervalMs: 5000, log }, { fetchImpl, now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const send = () => fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'whatever', messages: [{ role: 'user', content: 'hi' }] }) });
  const responses = await Promise.all([send(), send()]);
  for (const response of responses) assert.equal(response.status, 200);
  assert.deepEqual(seen.map((item) => item.model), ['forced', 'forced']);
  assert.equal(seen[0].url, 'https://up.example/v1/chat/completions');
  assert.deepEqual(waits, [5000], 'the second request waits for the interval');
  const entries = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(entries.length, 2);
  assert.equal(entries[0].requestedModel, 'whatever');
  assert.equal(entries[0].promptTokens, 10);
  const models = await (await fetch(base + '/models')).json();
  assert.equal(models.data[0].id, 'bench-model');
  assert.equal((await fetch(base + '/other', { method: 'POST' })).status, 404);
});

test('gateway refuses browser and rebinding requests and redacts keys echoed in upstream errors', async (t) => {
  // Regression: a web page could POST text/plain to the local gateway (no
  // preflight) and spend the upstream key; upstream 401 bodies that echo the
  // key were logged as-is.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-gw-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'log.jsonl');
  let upstreamCalls = 0;
  const echoed = 'sk-' + 'proj-Qz8Rv2Nm7Kp4Lw9Xc6Bt3Hy1Jd5Fs0Ga8';
  const fetchImpl = async () => { upstreamCalls++; return new Response(JSON.stringify({ error: { message: 'Invalid key ' + echoed } }), { status: 401, headers: { 'content-type': 'application/json' } }); };
  const server = createGateway({ host: '127.0.0.1', upstream: 'https://up.example/v1', model: 'm', minIntervalMs: 0, log }, { fetchImpl });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const port = server.address().port;
  const http = await import('node:http');
  const post = (headers) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/chat/completions', headers: { 'content-type': 'text/plain', ...headers } }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject);
    req.end(JSON.stringify({ model: 'x', messages: [] }));
  });
  assert.equal(await post({ origin: 'https://evil.example' }), 403);
  assert.equal(await post({ host: 'evil.example:' + port }), 403);
  assert.equal(upstreamCalls, 0);
  assert.equal(await post({}), 401, 'local clients still reach the upstream');
  const text = await readFile(log, 'utf8');
  assert.match(text, /"status":401/);
  assert.equal(text.includes(echoed), false, 'the echoed key was logged');
});

test('gateway spacing counts from the end of the previous reply, not its start', async (t) => {
  let clock = 1000;
  const waits = [];
  const fetchImpl = async () => {
    clock += 3000; // the reply takes 3 s
    return new Response(JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const server = createGateway({ upstream: 'https://up.example/v1', model: 'forced', minIntervalMs: 5000 }, { fetchImpl, now: () => clock, wait: async (ms) => { waits.push(ms); clock += ms; } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port + '/v1';
  const send = () => fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ messages: [] }) });
  const responses = await Promise.all([send(), send(), send()]);
  for (const response of responses) assert.equal(response.status, 200);
  assert.deepEqual(waits, [5000, 5000], 'a full interval after each 3 s reply, not 2 s');
});
