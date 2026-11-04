import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

// The checklist must not be written into the system prompt: changing messages[0]
// invalidates the provider prompt cache for the whole conversation.
test('todo_write keeps the system prompt byte-stable and sends the checklist as a reminder', async (t) => {
  const bodies = [];
  let call = 0;
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw));
    call += 1;
    const message = call === 1
      ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'Read the parser', status: 'in_progress' }, { content: 'Fix the bug', status: 'pending' }] }) } }] }
      : call === 2
        ? { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'todo_write', arguments: JSON.stringify({ todos: [{ content: 'Read the parser', status: 'completed' }, { content: 'Fix the bug', status: 'in_progress' }] }) } }] }
        : { role: 'assistant', content: 'Done.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-todo-'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6 }, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  await runAgentTurn(session, 'Fix the parser bug', {});
  assert.ok(bodies.length >= 3);
  const systems = bodies.map((body) => body.messages[0].content);
  assert.ok(systems.every((text) => text === systems[0]), 'system prompt changed between requests');
  assert.doesNotMatch(systems[0], /Current task checklist/);
  const last = bodies[bodies.length - 1].messages;
  const reminders = last.filter((m) => m.role === 'user' && String(m.content).includes('Current task checklist'));
  assert.equal(reminders.length, 2);
  assert.match(reminders[1].content, /\[completed\] Read the parser[\s\S]*\[in_progress\] Fix the bug/);
  // Each request's message list extends the previous one, so the cached prefix is reused.
  for (let index = 1; index < bodies.length; index++) {
    const before = JSON.stringify(bodies[index - 1].messages);
    assert.ok(JSON.stringify(bodies[index].messages).startsWith(before.slice(0, -1)), 'request ' + index + ' rewrote earlier messages');
  }
});
