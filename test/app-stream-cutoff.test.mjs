// The browser app's provider client: a stream that ends before the model
// finished is retried, not returned as the answer, and an overloaded_error
// event is retried while an authentication_error is not.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../app/core/providers.mjs';

const sse = (events) => new Response(events.map((e) => (typeof e === 'string' ? e : 'data: ' + JSON.stringify(e)) + '\n\n').join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const request = (fetchImpl) => ({ messages: [{ role: 'user', content: 'x' }], fetchImpl });

test('openai: a stream with no finish_reason and no [DONE] is retried', async () => {
  let calls = 0;
  const result = await chat({ protocol: 'openai', baseURL: 'http://p.test/v1', model: 'm', maxRetries: 2 }, request(async () => (++calls === 1
    ? sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'write_file', arguments: '{"path":"x","con' } }] } }] }])
    : sse([{ choices: [{ delta: { content: 'whole' } }] }, { choices: [{ delta: {}, finish_reason: 'stop' }] }, 'data: [DONE]']))));
  assert.equal(calls, 2);
  assert.equal(result.content, 'whole');
  assert.equal(result.tool_calls.length, 0);
});

const anthropic = { protocol: 'anthropic', baseURL: 'http://p.test', model: 'claude', apiKey: 'k', maxRetries: 2 };
const done = () => sse([{ type: 'message_start', message: { usage: { input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'whole' } }, { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]);

test('anthropic: a stream with no message_stop is retried', async () => {
  let calls = 0;
  const result = await chat(anthropic, request(async () => (++calls === 1 ? sse([{ type: 'message_start', message: { usage: { input_tokens: 1 } } }, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'half' } }]) : done())));
  assert.equal(calls, 2);
  assert.equal(result.content, 'whole');
});

test('anthropic: overloaded_error is retried, authentication_error is not', async () => {
  let calls = 0;
  const result = await chat(anthropic, request(async () => (++calls === 1 ? sse([{ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }]) : done())));
  assert.equal(calls, 2);
  assert.equal(result.content, 'whole');
  calls = 0;
  const err = await chat(anthropic, request(async () => { calls++; return sse([{ type: 'error', error: { type: 'authentication_error', message: 'bad key' } }]); })).catch((e) => e);
  assert.match(err.message, /bad key/);
  assert.equal(calls, 1);
});
