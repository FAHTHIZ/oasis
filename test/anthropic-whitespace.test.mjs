import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, requestCompletion, closeSession } from '../src/agent.mjs';

test('Anthropic requests never carry empty or whitespace-only text', async (t) => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-anthropic-ws-'));
  const session = await createSession({ root, config: { protocol: 'anthropic', baseURL: 'http://127.0.0.1:' + server.address().port, model: 'claude-fixture', apiKey: 'k' }, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); server.close(); await rm(root, { recursive: true, force: true }); });
  session.messages.push(
    { role: 'user', content: 'first' },
    { role: 'assistant', content: '' },
    { role: 'user', content: '   ' },
    { role: 'assistant', content: '\n\n' },
    { role: 'user', content: '' },
    { role: 'user', content: 'now?' }
  );
  await requestCompletion(session, { env: {} });
  const texts = [];
  for (const message of bodies[0].messages) {
    if (typeof message.content === 'string') texts.push(message.content);
    else for (const block of message.content) if (block.type === 'text') texts.push(block.text);
    assert.ok(typeof message.content === 'string' || message.content.length, 'no message without content');
  }
  for (const text of texts) assert.ok(text.trim(), 'whitespace-only text in ' + JSON.stringify(bodies[0].messages));
  assert.ok(texts.includes('now?'));
});
