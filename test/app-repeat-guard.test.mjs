// The browser agent's repeated-call guard resets after a file change.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, Workspace } from '../app/core/workspace.mjs';
import { Agent } from '../app/core/agent.mjs';

const call = (id, name, args) => ({ content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

async function run(replies) {
  const ws = await Workspace.create(new MemoryStore(), { name: 'demo', files: [{ path: 'a.js', content: 'let v = 0;\n' }] });
  const results = [];
  const agent = new Agent({ getConfig: () => ({ mode: 'auto' }), getContext: () => ({ workspace: ws }), approve: async () => true,
    onEvent: (event) => { if (event.type === 'tool_result') results.push(event); },
    chatImpl: async (_config, request) => replies[Math.min(request.messages.filter((m) => m.role === 'assistant').length, replies.length - 1)] });
  await agent.send('fix it');
  return results;
}

test('the same check after each edit is not treated as a repeat', async () => {
  const check = { pattern: 'v = ' };
  const results = await run([
    call('g1', 'grep', check),
    call('e1', 'edit_file', { path: 'a.js', old_string: 'v = 0', new_string: 'v = 1' }),
    call('g2', 'grep', check),
    call('e2', 'edit_file', { path: 'a.js', old_string: 'v = 1', new_string: 'v = 2' }),
    call('g3', 'grep', check),
    { content: 'Done.' }
  ]);
  const greps = results.filter((r) => r.name === 'grep');
  assert.equal(greps.length, 3);
  for (const r of greps) assert.equal(r.ok, true, r.content);
  assert.match(greps[2].content, /v = 2/);
});

test('the same call three times with no change in between is still stopped', async () => {
  const check = { pattern: 'v = ' };
  const results = await run([call('g1', 'grep', check), call('g2', 'grep', check), call('g3', 'grep', check), { content: 'Done.' }]);
  assert.equal(results[2].ok, false);
  assert.match(results[2].content, /already made this exact call/);
});
