import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';

test('stopping a turn mid-reply keeps the request and the partial reply in history', async (t) => {
  const server = createServer(async (req, res) => {
    for await (const chunk of req) void chunk;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ choices: [{ delta: { content: 'Step one: open the config file' } }] }));
    // Never finishes; the client cancels.
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cancel-'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 }, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  const controller = new AbortController();
  const turn = runAgentTurn(session, 'explain the setup steps', {
    signal: controller.signal,
    onDelta: (text) => { if (text.includes('config file')) controller.abort(); }
  });
  await assert.rejects(turn, (error) => error.name === 'AbortError' || /cancel/i.test(error.message));
  const user = session.messages.filter((message) => message.role === 'user').at(-1);
  assert.match(String(user.content), /explain the setup steps/);
  const last = session.messages.at(-1);
  assert.equal(last.role, 'assistant');
  assert.match(last.content, /^Step one: open the config file/);
  assert.match(last.content, /interrupted by the user/);
});
