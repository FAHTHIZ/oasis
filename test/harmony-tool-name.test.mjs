import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

// Seen live with gpt-oss-20b: the model named its call
// "read_file<|channel|>commentary"; OASIS echoed that name in the tool result
// and the provider rejected the next request with HTTP 400, ending the task.
test('a tool name with leaked harmony tokens runs the tool and is sent back clean', async (t) => {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    const bad = body.messages.flatMap((m) => [m.name, ...(m.tool_calls || []).map((c) => c.function.name)]).filter((n) => n && !/^[a-zA-Z0-9_-]{1,64}$/.test(n));
    if (bad.length) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: "Invalid message name for role 'tool'." } })); return; }
    const message = bodies.length === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file<|channel|>commentary', arguments: '{"path":"a.txt"}' } }] }
      : { role: 'assistant', content: 'The file says hello.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: bodies.length === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-harmony-'));
  await writeFile(path.join(root, 'a.txt'), 'hello\n');
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'gpt-oss-20b', apiKey: '', maxSteps: 4, stream: false };
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  const result = await runAgentTurn(session, 'What does a.txt say?', {});
  assert.equal(bodies.length, 2);
  const toolMessage = bodies[1].messages.find((m) => m.role === 'tool');
  assert.match(String(toolMessage.content), /hello/);
  assert.match(String(result.text || result.content || result.finalText || JSON.stringify(result)), /hello/);
});
