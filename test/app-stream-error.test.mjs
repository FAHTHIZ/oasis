import test from 'node:test';
import assert from 'node:assert/strict';
import { chat, strayStreamError } from '../app/core/providers.mjs';

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
const streamResponse = (text) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { status: 200, headers: { 'content-type': 'text/event-stream' } });

// Captured from Gemini's OpenAI endpoint: text, then a bare JSON 503, no [DONE].
test('the app retries a stream that ends in a bare JSON error instead of keeping the fragment', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return streamResponse(sse({ choices: [{ delta: { content: 'I am', role: 'assistant' }, index: 0 }] }) + '[{\n  "error": {\n    "code": 503,\n    "message": "This model is currently experiencing high demand.",\n    "status": "UNAVAILABLE"\n  }\n}\n]');
    return streamResponse(sse({ choices: [{ delta: { content: 'All done.' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  };
  const retries = [];
  const reply = await chat({ protocol: 'openai-compatible', baseURL: 'https://example.test/v1', model: 'm', apiKey: 'k', maxRetries: 2 }, { messages: [{ role: 'user', content: 'hi' }], fetchImpl, onText: () => {}, onRetry: (attempt, error) => retries.push(error.message) });
  assert.equal(reply.content, 'All done.');
  assert.equal(calls, 2);
  assert.match(retries[0], /high demand/);
});

test('a normal stream without stray text is untouched', async () => {
  const fetchImpl = async () => streamResponse(sse({ choices: [{ delta: { content: 'Hi.' } }] }) + 'data: [DONE]\n\n');
  const reply = await chat({ protocol: 'openai-compatible', baseURL: 'https://example.test/v1', model: 'm', apiKey: 'k' }, { messages: [{ role: 'user', content: 'hi' }], fetchImpl, onText: () => {} });
  assert.equal(reply.content, 'Hi.');
  assert.equal(strayStreamError(': keep-alive'), null);
});

test('the app asks again when Gemini ends with MALFORMED_FUNCTION_CALL and no output', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    if (calls === 1) return streamResponse(sse({ choices: [{ delta: { role: 'assistant' }, finish_reason: 'function_call_filter: MALFORMED_FUNCTION_CALL', index: 0 }] }) + 'data: [DONE]\n\n');
    return streamResponse(sse({ choices: [{ delta: { content: 'Fixed.' } }] }) + sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
  };
  const reply = await chat({ protocol: 'openai-compatible', baseURL: 'https://example.test/v1', model: 'm', apiKey: 'k', maxRetries: 2 }, { messages: [{ role: 'user', content: 'hi' }], fetchImpl, onText: () => {}, onRetry: () => {} });
  assert.equal(reply.content, 'Fixed.');
  assert.equal(calls, 2);
});
