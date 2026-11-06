import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { runHeadless } from '../src/headless.mjs';

// Headless and eval runs used to send non-streaming requests, so a provider
// that stalled mid-reply held the run for the 600 s whole-request timeout.
// Streaming puts them under the 120 s header timeout and the idle watchdog.

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

async function provider(t, { stall = false } = {}) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const parsed = JSON.parse(body);
    bodies.push(parsed);
    if (stall) {
      // Headers and a first chunk, then nothing: a stalled upstream.
      res.writeHead(200, { 'content-type': parsed.stream ? 'text/event-stream' : 'application/json' });
      res.write(parsed.stream ? 'data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}\n\n' : '{"choices":[');
      return;
    }
    if (parsed.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hello."}}]}\n\n');
      res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2,"total_tokens":7}}\n\n');
      res.end('data: [DONE]\n\n');
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Hello.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  return { bodies, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 3 } };
}

async function run(t, config, env) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-headless-stream-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fullEnv = { ...process.env, HOME: root, OASIS_CONFIG_DIR: root, ...env };
  return runHeadless({ prompt: 'hi', root, config, outputFormat: 'json', env: fullEnv, sessionOptions: { settings, env: fullEnv }, write: () => {} });
}

test('oasis -p streams its requests and still reports the reply and usage', async (t) => {
  const { config, bodies } = await provider(t);
  const { summary } = await run(t, config, {});
  assert.equal(bodies[0].stream, true);
  assert.equal(summary.result, 'Hello.');
  assert.equal(summary.usage.input_tokens, 5);
});

test('OASIS_NO_STREAM=1 keeps oasis -p on whole replies', async (t) => {
  const { config, bodies } = await provider(t);
  const { summary } = await run(t, config, { OASIS_NO_STREAM: '1' });
  assert.equal(bodies[0].stream, undefined);
  assert.equal(summary.result, 'Hello.');
});

test('a provider that stalls mid-reply is caught by the idle watchdog in oasis -p', async (t) => {
  const { config, bodies } = await provider(t, { stall: true });
  const previous = process.env.OASIS_STREAM_IDLE_SECONDS;
  process.env.OASIS_STREAM_IDLE_SECONDS = '1';
  t.after(() => { if (previous === undefined) delete process.env.OASIS_STREAM_IDLE_SECONDS; else process.env.OASIS_STREAM_IDLE_SECONDS = previous; });
  const started = Date.now();
  const outcome = await Promise.race([
    run(t, config, { OASIS_STREAM_IDLE_SECONDS: '1' }).then((value) => ({ value }), (error) => ({ error })),
    new Promise((resolve) => setTimeout(() => resolve({ hung: true }), 20000))
  ]);
  assert.ok(!outcome.hung, 'the run was still waiting on the stalled reply after 20 s');
  assert.ok(Date.now() - started < 20000);
  const text = outcome.error ? outcome.error.message : JSON.stringify(outcome.value.summary);
  assert.match(text, /stalled/);
  assert.ok(bodies.length >= 2, 'the stalled stream was restarted');
});
