// The browser app's Anthropic client asks for the model's real output limit
// (32,000 for current Claude models instead of a flat 8,192) and, when the
// API names a smaller maximum, retries once at it and remembers it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../app/core/providers.mjs';
import { anthropicDefaultOutputTokens } from '../src/output-cap.mjs';

const sse = (events) => new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
const done = () => sse([
  { type: 'message_start', message: { usage: { input_tokens: 1 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
  { type: 'message_stop' }
]);

test('default Anthropic output limits follow the model generation', () => {
  assert.equal(anthropicDefaultOutputTokens('claude-3-haiku-20240307'), 4096);
  assert.equal(anthropicDefaultOutputTokens('claude-3-5-sonnet-latest'), 8192);
  assert.equal(anthropicDefaultOutputTokens('claude-sonnet-4-5'), 32000);
  assert.equal(anthropicDefaultOutputTokens('claude-opus-5'), 32000);
});

test('a max_tokens 400 is retried once at the reported limit, which is then remembered', async () => {
  const config = { protocol: 'anthropic', baseURL: 'http://cap.test', model: 'claude-small-out', apiKey: 'k', maxRetries: 0 };
  const sent = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body.max_tokens);
    if (body.max_tokens > 16000) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'max_tokens: ' + body.max_tokens + ' > 16000, which is the maximum allowed number of output tokens for claude-small-out' } }), { status: 400 });
    }
    return done();
  };
  const first = await chat(config, { messages: [{ role: 'user', content: 'x' }], fetchImpl });
  assert.equal(first.content, 'ok');
  assert.deepEqual(sent, [32000, 16000]);
  await chat(config, { messages: [{ role: 'user', content: 'y' }], fetchImpl });
  assert.deepEqual(sent, [32000, 16000, 16000], 'the learned limit is reused');
});
