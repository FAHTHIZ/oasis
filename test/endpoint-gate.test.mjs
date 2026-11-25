import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { acquireEndpoint, endpointGateState, resetEndpointGates } from '../src/endpoint-gate.mjs';
import { isConcurrencyLimit } from '../src/provider-retry.mjs';

test('an unlimited endpoint never waits; a learned limit makes requests take turns', async () => {
  resetEndpointGates();
  const config = { baseURL: 'https://one.example/v1' };
  const a = await acquireEndpoint(config);
  const b = await acquireEndpoint(config);
  assert.equal(endpointGateState(config).active, 2);
  let cTurn = false;
  const c = acquireEndpoint(config).then((handle) => { cTurn = true; return handle; });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(cTurn, true, 'no limit yet');
  const requeued = a.requeue(1);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(endpointGateState(config).limit, 1);
  b.release(); (await c).release();
  await requeued;
  assert.equal(endpointGateState(config).active, 1);
  a.release();
  assert.equal(endpointGateState(config).active, 0);
});

test('a cancelled wait leaves the queue', async () => {
  resetEndpointGates();
  const config = { baseURL: 'https://two.example/v1', maxConcurrentRequests: 1 };
  const first = await acquireEndpoint(config);
  const controller = new AbortController();
  const waiting = acquireEndpoint(config, { signal: controller.signal });
  controller.abort();
  await assert.rejects(waiting);
  assert.equal(endpointGateState(config).waiting, 0);
  first.release();
});

test('the Pollinations one-at-a-time 429 is a concurrency limit, a daily quota is not', () => {
  assert.equal(isConcurrencyLimit('Your previous request is still running. The Classic API answers 1 request at a time per IP.'), true);
  assert.equal(isConcurrencyLimit('Too many concurrent requests'), true);
  assert.equal(isConcurrencyLimit('You exceeded your daily quota'), false);
});

test('agents sharing a one-at-a-time endpoint all finish instead of failing on 429', async (t) => {
  resetEndpointGates();
  let busy = false;
  let collisions = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    if (busy) { collisions++; res.writeHead(429, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Your previous request is still running. 1 request at a time per IP.' } })); return; }
    busy = true;
    await new Promise((r) => setTimeout(r, 120));
    busy = false;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const { requestCompletion } = await import('../src/agent-request.mjs');
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: '' };
  const env = { ...process.env, OASIS_TELEMETRY: '0' };
  const replies = await Promise.all([1, 2, 3, 4].map(() => requestCompletion({ config, messages: [{ role: 'user', content: 'hi' }], toolDefinitions: [] }, { env, tools: [] })));
  assert.equal(replies.length, 4);
  for (const reply of replies) assert.match(JSON.stringify(reply), /ok/);
  assert.ok(collisions <= 3, 'it learned the limit after the first collisions (' + collisions + ')');
});
