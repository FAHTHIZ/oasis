// The browser app's provider calls fail after a silent stretch instead of
// waiting forever, retrying a stall that happened before any data.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../app/core/providers.mjs';

const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'm', streamIdleMs: 150, maxRetries: 2 };
const sse = (events, { hang = false } = {}) => new Response(new ReadableStream({
  start(controller) {
    for (const event of events) controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'));
    if (!hang) { controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close(); }
  }
}), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const chunk = (text) => ({ choices: [{ delta: { content: text } }] });
const finish = { choices: [{ delta: {}, finish_reason: 'stop' }] };

test('a provider that never answers is retried, then the next attempt succeeds', async () => {
  let calls = 0;
  const fetchImpl = (_url, init) => {
    calls++;
    if (calls === 1) return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    return Promise.resolve(sse([chunk('hello'), finish]));
  };
  const reply = await chat(config, { messages: [{ role: 'user', content: 'hi' }], fetchImpl, onRetry: () => {} });
  assert.equal(calls, 2);
  assert.equal(reply.content, 'hello');
});

test('a stream that goes silent after text is reported, not retried', async () => {
  let calls = 0;
  const fetchImpl = () => { calls++; return Promise.resolve(sse([chunk('partial')], { hang: true })); };
  const started = Date.now();
  await assert.rejects(chat(config, { messages: [{ role: 'user', content: 'hi' }], fetchImpl, onText: () => {} }), /stream stalled/);
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 5000);
});

test('Stop still cancels a stalled call as a stop, not a stall', async () => {
  const controller = new AbortController();
  const fetchImpl = (_url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(chat({ ...config, streamIdleMs: 5000 }, { messages: [{ role: 'user', content: 'hi' }], fetchImpl, signal: controller.signal }), (error) => error.name === 'AbortError');
});

test('a normal reply leaves no timer behind', async () => {
  const reply = await chat({ ...config, streamIdleMs: 60_000 }, { messages: [{ role: 'user', content: 'hi' }], fetchImpl: async () => sse([chunk('ok'), finish]) });
  assert.equal(reply.content, 'ok');
});
