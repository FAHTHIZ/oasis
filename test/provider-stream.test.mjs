import test from 'node:test';
import assert from 'node:assert/strict';
import {
  consumeServerSentEvents,
  readProviderStream,
  mergeExtraContent
} from '../src/provider-stream.mjs';

function responseFromChunks(chunks) {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    }
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

test('provider SSE parser handles split CRLF, multiline data, comments and final unterminated event', async () => {
  const events = [];
  const stray = [];
  const response = responseFromChunks([
    ': keepalive\r\nevent: update\r\ndata: first\r',
    '\ndata: second\r\n\r\n: ignored\r\ndata: final'
  ]);
  await consumeServerSentEvents(response, (event) => events.push(event), (line) => stray.push(line));
  assert.deepEqual(events, [
    { event: 'update', data: 'first\nsecond' },
    { event: 'message', data: 'final' }
  ]);
  assert.deepEqual(stray, []);
});

test('provider stream parsing returns the complete chat response and forwards text deltas', async () => {
  const deltas = [];
  const response = responseFromChunks([
    'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
    'data: [DONE]\n\n'
  ]);
  const result = await readProviderStream(response, 'openai-compatible', (delta) => deltas.push(delta));
  assert.deepEqual(deltas, ['Hello']);
  assert.equal(result.choices[0].message.content, 'Hello');
  assert.equal(result.choices[0].finish_reason, 'stop');
});

test('provider stream parser rejects an interrupted response instead of accepting partial output', async () => {
  const response = responseFromChunks(['data: {"choices":[{"delta":{"content":"Partial"}}]}\n\n']);
  await assert.rejects(readProviderStream(response, 'openai-compatible', () => {}), {
    code: 'OASIS_STREAM_INTERRUPTED'
  });
});

test('provider stream metadata merges nested objects without losing prior fields', () => {
  assert.deepEqual(
    mergeExtraContent({ google: { thought: true, signature: 'a' }, existing: true }, { google: { signature: 'b' } }),
    { google: { thought: true, signature: 'b' }, existing: true }
  );
});
