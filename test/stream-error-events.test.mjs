// An error event inside a 200 stream: Anthropic's overloaded_error / api_error
// and the Responses API's server_error clear on a restart; an
// authentication or invalid-request error stays final.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { anthropicStreamError, responsesStreamError } from '../src/provider-stream.mjs';

test('stream error events are classified', () => {
  const over = anthropicStreamError({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } });
  assert.equal(over.code, 'OASIS_STREAM_INTERRUPTED');
  assert.equal(over.status, 529);
  assert.equal(anthropicStreamError({ type: 'error', error: { type: 'api_error', message: 'Internal' } }).status, 500);
  const auth = anthropicStreamError({ type: 'error', error: { type: 'authentication_error', message: 'bad key' } });
  assert.equal(auth.code, undefined);
  assert.equal(auth.message, 'bad key');
  assert.equal(responsesStreamError({ type: 'response.failed', response: { error: { code: 'server_error', message: 'oops' } } }).code, 'OASIS_STREAM_INTERRUPTED');
  assert.equal(responsesStreamError({ type: 'response.failed', response: { error: { code: 'invalid_prompt', message: 'no' } } }).code, undefined);
});

async function run(t, errorType) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-stream-err-'));
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event) => res.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n');
    send({ type: 'message_start', message: { id: 'm' + requests, model: 'fixture', usage: { input_tokens: 5, output_tokens: 0 } } });
    if (requests === 1) { send({ type: 'error', error: { type: errorType, message: 'Overloaded' } }); res.end(); return; }
    send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Full answer.' } });
    send({ type: 'content_block_stop', index: 0 });
    send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
    send({ type: 'message_stop' });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = { protocol: 'anthropic', baseURL: 'http://127.0.0.1:' + server.address().port, model: 'claude-fixture', apiKey: 'k' };
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: root, OASIS_STREAM_RESTART_DELAY_MS: '1' };
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions', env });
  t.after(async () => { closeSession(session); server.close(); await rm(root, { recursive: true, force: true }); });
  const result = await runAgentTurn(session, 'Explain.', { onDelta: () => {}, onText: () => {} }).catch((error) => ({ error }));
  return { result, requests };
}

test('an Anthropic overloaded_error mid-stream is retried', async (t) => {
  const { result, requests } = await run(t, 'overloaded_error');
  assert.equal(result.text, 'Full answer.');
  assert.equal(requests, 2);
});

test('an Anthropic invalid_request_error mid-stream is final', async (t) => {
  const { result, requests } = await run(t, 'invalid_request_error');
  assert.ok(result.error);
  assert.equal(requests, 1);
});
