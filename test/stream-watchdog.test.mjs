import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';

const chunk = (text) => 'data: ' + JSON.stringify({ choices: [{ delta: { content: text } }] }) + '\n\n';

async function streamingServer(t, handler) {
  const sockets = new Set();
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    await handler(res);
  });
  server.on('connection', (socket) => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => server.close(resolve)); });
  return 'http://127.0.0.1:' + server.address().port + '/v1';
}

async function session(t, baseURL) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-stream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return createSession({ root, config: { protocol: 'openai-compatible', baseURL, model: 'fixture', apiKey: '', maxSteps: 2 } });
}

test('a stream that keeps producing tokens is not cut off by the request timeout', async (t) => {
  const baseURL = await streamingServer(t, async (res) => {
    for (let i = 0; i < 8; i++) { res.write(chunk('part' + i + ' ')); await new Promise((resolve) => setTimeout(resolve, 300)); }
    res.end('data: [DONE]\n\n');
  });
  let streamed = '';
  const result = await runAgentTurn(await session(t, baseURL), 'Write a long answer.', {
    env: { ...process.env, OASIS_REQUEST_TIMEOUT_SECONDS: '1', OASIS_STREAM_IDLE_SECONDS: '2' },
    onDelta: (delta) => { streamed += typeof delta === 'string' ? delta : (delta && delta.text) || ''; }
  });
  assert.match(result.text + streamed, /part7/, 'the full 2.4s stream arrived despite a 1s header timeout');
});

test('a stream that goes silent is aborted by the idle watchdog with a clear message', async (t) => {
  const baseURL = await streamingServer(t, async (res) => { res.write(chunk('hello ')); });
  const started = Date.now();
  let failure = '';
  try {
    const result = await runAgentTurn(await session(t, baseURL), 'Hi', { env: { ...process.env, OASIS_STREAM_IDLE_SECONDS: '1' }, onDelta: () => {} });
    failure = JSON.stringify(result);
  } catch (error) { failure = error.message; }
  assert.match(failure, /stream stalled: no data arrived for 1 seconds/);
  assert.ok(Date.now() - started < 15000, 'did not hang');
});
