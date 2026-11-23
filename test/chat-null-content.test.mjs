import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { withChatContent } from '../src/provider-requests.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';

test('an assistant message without content or tool calls is sent with empty content', () => {
  const calls = [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }];
  const input = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null },
    { role: 'assistant', content: null, tool_calls: calls },
    { role: 'assistant', content: undefined, tool_calls: [] }
  ];
  const out = withChatContent(input);
  assert.deepEqual(out[1], { role: 'assistant', content: '' });
  assert.equal(out[2].content, null, 'a tool-call message keeps null content, which every server accepts');
  assert.deepEqual(out[3], { role: 'assistant', content: '' });
  assert.equal(withChatContent([{ role: 'user', content: 'x' }]).length, 1);
  const untouched = [{ role: 'assistant', content: 'ok' }];
  assert.equal(withChatContent(untouched), untouched);
});

// Seen live with qwen2.5:1.5b through Ollama 0.40.17: the model wrote a fake
// <tool_response>, OASIS stripped it to nothing, and the next request replayed
// an assistant turn with null content and no tool calls: HTTP 400.
for (const [label, first] of [
  ['a reply that is only a fake tool result', { role: 'assistant', content: '<tool_response>\n{"ok": true, "stdout": "archived 3 files"}\n</tool_response>' }],
  ['an empty reply', { role: 'assistant', content: null }]
]) test('after ' + label + ' the next request is not refused by an Ollama-strict server', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-null-content-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let requests = 0;
  let refused = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    requests += 1;
    // What Ollama does: content must be a string or an array of parts.
    if (payload.messages.some((m) => m.content === null && !(m.tool_calls && m.tool_calls.length)) || payload.messages.some((m) => m.content === undefined)) {
      refused += 1;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'invalid message content type: <nil>' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    const message = requests === 1 ? first : { role: 'assistant', content: 'Hello.' };
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, '.cfg') };
  delete env.NODE_TEST_CONTEXT;
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6 } });
  const result = await runAgentTurn(session, 'Say hello.', { autoApprove: true, env });
  assert.equal(refused, 0, 'no request carried a null-content assistant message');
  assert.ok(requests >= 2);
  assert.match(result.text, /Hello/);
});
