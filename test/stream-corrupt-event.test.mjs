import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { readProviderStream } from '../src/provider-stream.mjs';

// A gateway that corrupts one SSE data event (a cut or interleaved chunk) is
// a transient stream fault: the reply restarts instead of failing the turn.
function streamOf(text) {
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}

for (const protocol of ['openai-compatible', 'anthropic', 'openai-responses']) {
  test(protocol + ': a non-JSON data event is reported as a restartable stream interruption', async () => {
    await assert.rejects(readProviderStream(streamOf('data: {"choices":[{"delta":{"content":"a"\n\n'), protocol, () => {}),
      (error) => error.code === 'OASIS_STREAM_INTERRUPTED' && /invalid server-sent event payload/.test(error.message));
  });
}

test('a corrupted event mid-reply restarts the request and the turn completes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-corrupt-event-'));
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) { res.write('data: {"choices":[{"delta":{"content":"par\n\n'); return res.end(); }
    res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Full answer.' } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '' };
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions', env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: root } });
  t.after(async () => { closeSession(session); server.close(); await rm(root, { recursive: true, force: true }); });
  const restarts = [];
  const result = await runAgentTurn(session, 'Explain.', { onDelta: () => {}, onText: () => {}, onStreamRestart: (info) => restarts.push(info) });
  assert.equal(result.text, 'Full answer.');
  assert.equal(requests, 2);
  assert.equal(restarts.length, 1);
});
