// The browser app's provider client follows the same retry headers as the
// OpenAI and Anthropic SDKs: x-should-retry and retry-after-ms / Retry-After.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, retryPlan } from '../app/core/providers.mjs';

const config = { protocol: 'openai', baseURL: 'http://provider.test/v1', model: 'm', apiKey: 'k', maxRetries: 3 };
const ok = () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }] }), { status: 200, headers: { 'content-type': 'application/json' } });

test('retryPlan reads x-should-retry and the advised wait', () => {
  assert.deepEqual(retryPlan(503, '', new Headers({ 'x-should-retry': 'false' })), { retryable: false });
  assert.equal(retryPlan(409, '', new Headers({ 'x-should-retry': 'true' })).retryable, true);
  assert.equal(retryPlan(529, '', new Headers({ 'retry-after-ms': '250' })).waitMs, 250);
  assert.equal(retryPlan(503, '', new Headers({ 'retry-after': '2' })).waitMs, 2000);
  assert.equal(retryPlan(503, '', new Headers({ 'retry-after': '3600' })).waitMs, undefined);
  assert.equal(retryPlan(400, '', new Headers({ 'retry-after': '1' })).waitMs, undefined);
  assert.equal(retryPlan(503).retryable, true);
});

test('a 503 marked x-should-retry: false is not retried', async () => {
  let calls = 0;
  const err = await chat(config, { messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => { calls++; return new Response('{"error":{"message":"down"}}', { status: 503, headers: { 'x-should-retry': 'false' } }); } }).catch((e) => e);
  assert.ok(err instanceof Error);
  assert.equal(calls, 1);
});

test('a 409 marked x-should-retry: true is retried after the advised wait', async () => {
  let calls = 0;
  const waits = [];
  const started = Date.now();
  const reply = await chat(config, {
    messages: [{ role: 'user', content: 'x' }],
    onRetry: (attempt, error) => waits.push(error.waitMs),
    fetchImpl: async () => (++calls === 1 ? new Response('{"error":{"message":"lock"}}', { status: 409, headers: { 'x-should-retry': 'true', 'retry-after-ms': '20' } }) : ok())
  });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [20]);
  assert.ok(Date.now() - started < 1500);
  assert.match(JSON.stringify(reply), /done/);
});
