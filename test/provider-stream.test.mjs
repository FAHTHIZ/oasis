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

test('a long reply whose SSE envelope runs past 8 MiB still streams in full', async () => {
  // 80,000 one-token deltas in the OpenAI chunk format: ~16 MiB on the wire
  // for ~80k output tokens, which a long reasoning or writing turn reaches.
  const envelope = (text) => 'data: ' + JSON.stringify({ id: 'chatcmpl-0123456789abcdefghijklmnop', object: 'chat.completion.chunk', created: 1763000000, model: 'gpt-5.1-2025-11-13', system_fingerprint: 'fp_0123456789', choices: [{ index: 0, delta: { content: text }, logprobs: null, finish_reason: null }] }) + '\n\n';
  const count = 80000;
  const chunks = [];
  let batch = '';
  for (let i = 0; i < count; i++) {
    batch += envelope('x');
    if (batch.length > 64 * 1024) { chunks.push(batch); batch = ''; }
  }
  chunks.push(batch + 'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  const wire = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  assert.ok(wire > 12 * 1024 * 1024, 'the fixture exceeds the old 8 MiB cap');
  let deltas = 0;
  const result = await readProviderStream(responseFromChunks(chunks), 'openai-compatible', () => { deltas++; });
  assert.equal(deltas, count);
  assert.equal(result.choices[0].message.content.length, count);
  assert.equal(result.choices[0].finish_reason, 'stop');
});

test('a single stream event larger than 32 MiB is refused without buffering the rest', async () => {
  let pulled = 0;
  const piece = new TextEncoder().encode('x'.repeat(1024 * 1024));
  const body = new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('data: ')); },
    pull(controller) {
      pulled++;
      if (pulled > 200) { controller.close(); return; }
      controller.enqueue(piece);
    }
  });
  const response = new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  await assert.rejects(consumeServerSentEvents(response, () => {}), /single stream event larger than 32 MiB/);
  assert.ok(pulled < 40, 'reading stops soon after the cap');
});
