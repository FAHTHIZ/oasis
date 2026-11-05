import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';

// Serves OpenAI-compatible SSE. The first `drops` requests send a partial reply
// and then cut the connection mid-stream.
async function flakyStreamServer(t, drops) {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests <= drops) {
      res.write(sse({ choices: [{ delta: { content: 'Partial ' } }] }));
      setTimeout(() => res.socket.destroy(), 20);
      return;
    }
    res.write(sse({ choices: [{ delta: { content: 'Complete answer.' } }] }));
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } }));
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return {
    config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 },
    count: () => requests
  };
}

async function session(t, config) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-stream-'));
  const value = await createSession({ root, config, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(value); await rm(root, { recursive: true, force: true }); });
  return value;
}

test('a stream that drops mid-response is retried on the same model', async (t) => {
  const server = await flakyStreamServer(t, 1);
  const restarts = [];
  const shown = [];
  const result = await runAgentTurn(await session(t, server.config), 'hi', {
    onDelta: (text) => shown.push(text),
    onStreamRestart: (event) => restarts.push(event)
  });
  assert.equal(result.text, 'Complete answer.');
  // Deltas are cumulative: the partial text is cleared, never duplicated.
  assert.equal(shown.at(-1), 'Complete answer.');
  assert.ok(shown.includes(''));
  assert.ok(!shown.some((text) => text.includes('Partial Complete')));
  assert.equal(server.count(), 2);
  assert.equal(restarts.length, 1);
  assert.match(restarts[0].reason, /interrupted/);
});

test('repeated mid-stream drops give up with a clear error after bounded restarts', async (t) => {
  const server = await flakyStreamServer(t, 10);
  await assert.rejects(runAgentTurn(await session(t, server.config), 'hi', { onDelta: () => {}, onStreamRestart: () => {} }), /stream was interrupted/);
  assert.equal(server.count(), 3);
});

// Seen live on Gemini's OpenAI endpoint: a few data events, then a plain JSON
// 503 body and no [DONE]. OASIS used to show the fragment ("I am") as the answer.
test('a JSON error appended mid-stream is retried, not shown as the answer', async (t) => {
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      res.write(sse({ choices: [{ delta: { content: 'I am', role: 'assistant' }, index: 0 }] }));
      res.end('[{\n  "error": {\n    "code": 503,\n    "message": "This model is currently experiencing high demand.",\n    "status": "UNAVAILABLE"\n  }\n}\n]');
      return;
    }
    res.write(sse({ choices: [{ delta: { content: 'I am done.' } }] }));
    res.write(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }));
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 };
  const restarts = [];
  const result = await runAgentTurn(await session(t, config), 'hi', { onDelta: () => {}, onStreamRestart: (event) => restarts.push(event) });
  assert.equal(result.text, 'I am done.');
  assert.equal(requests, 2);
  assert.match(restarts[0].reason, /high demand/);
});

test('strayStreamError reads array, object and partial JSON error bodies', async () => {
  const { strayStreamError } = await import('../src/agent.mjs');
  assert.deepEqual(strayStreamError('[{"error":{"code":503,"message":"busy"}}]'), { message: 'busy', status: 503 });
  assert.deepEqual(strayStreamError('{"error":"nope"}'), { message: 'nope', status: 0 });
  assert.deepEqual(strayStreamError('{"error": {"code": 500, "message": "boom"'), { message: 'boom', status: 500 });
  assert.equal(strayStreamError(''), null);
  assert.equal(strayStreamError('hello'), null);
});
