import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';

// Models send wide read batches; a 16-call cap answered the rest with
// "Not executed" and cost the model a step to ask again.
test('a batch of 24 parallel reads runs every call', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wide-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 24; i++) await writeFile(path.join(root, 'f' + i + '.txt'), 'file ' + i + '\n');
  let requests = 0;
  let second = null;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests++;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    if (requests === 1) {
      const tool_calls = Array.from({ length: 24 }, (_, i) => ({ index: i, id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'f' + i + '.txt' }) } }));
      res.write(sse({ choices: [{ delta: { tool_calls } }] }));
    } else {
      second = JSON.parse(body);
      res.write(sse({ choices: [{ delta: { content: 'Done.' } }] }));
    }
    res.write(sse({ choices: [{ delta: {}, finish_reason: requests === 1 ? 'tool_calls' : 'stop' }] }));
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 }, permissionMode: 'bypassPermissions' });
  t.after(() => closeSession(session));
  const started = [];
  const result = await runAgentTurn(session, 'read them all', { onDelta: () => {}, onToolStart: (event) => started.push(event.name) });
  assert.equal(result.text, 'Done.');
  assert.equal(started.length, 24);
  const toolMessages = second.messages.filter((message) => message.role === 'tool');
  assert.equal(toolMessages.length, 24);
  assert.ok(!toolMessages.some((message) => /Not executed/.test(String(message.content))));
  assert.match(String(toolMessages[23].content), /file 23/);
});
