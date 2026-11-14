import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

// The first reply is cut off: the server closes the connection cleanly after
// part of the text, with no finish_reason / [DONE] (chat) or message_stop
// (Anthropic). The partial text must not be taken as the answer.
async function run(t, protocol) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-stream-drop-'));
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (event) => res.write('data: ' + JSON.stringify(event) + '\n\n');
    const cut = requests === 1;
    if (protocol === 'openai-responses') {
      send({ type: 'response.output_text.delta', delta: cut ? 'The answer is that the fun' : 'Full answer.' });
      if (!cut) send({ type: 'response.completed', response: { id: 'r' + requests, status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Full answer.' }] }], usage: { input_tokens: 5, output_tokens: 3 } } });
    } else if (protocol === 'anthropic') {
      send({ type: 'message_start', message: { id: 'm' + requests, model: 'fixture', usage: { input_tokens: 5, output_tokens: 0 } } });
      send({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      send({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: cut ? 'The answer is that the fun' : 'Full answer.' } });
      if (!cut) {
        send({ type: 'content_block_stop', index: 0 });
        send({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } });
        send({ type: 'message_stop' });
      }
    } else {
      send({ choices: [{ delta: { content: cut ? 'The answer is that the fun' : 'Full answer.' } }] });
      if (!cut) { send({ choices: [{ delta: {}, finish_reason: 'stop' }] }); res.write('data: [DONE]\n\n'); }
    }
    setTimeout(() => res.end(), 10);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const config = protocol === 'anthropic'
    ? { protocol: 'anthropic', baseURL: base, model: 'claude-fixture', apiKey: 'k' }
    : { protocol, baseURL: base + '/v1', model: 'fixture', apiKey: '' };
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions', env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: root } });
  t.after(async () => { closeSession(session); server.close(); await rm(root, { recursive: true, force: true }); });
  const result = await runAgentTurn(session, 'Explain the function.', { onDelta: () => {}, onText: () => {} });
  return { result, requests };
}

for (const protocol of ['openai-compatible', 'anthropic', 'openai-responses']) {
  test(protocol + ': a stream cut off mid-reply is restarted, not returned as the answer', async (t) => {
    const { result, requests } = await run(t, protocol);
    assert.equal(result.text, 'Full answer.');
    assert.equal(requests, 2);
  });
}
