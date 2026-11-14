// The browser app's agent gives repeated or empty tool-call IDs in one reply
// fresh ones, so each result answers exactly one call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, Workspace } from '../app/core/workspace.mjs';
import { Agent } from '../app/core/agent.mjs';

test('duplicate and empty tool-call IDs get unique replacements', async () => {
  const ws = await Workspace.create(new MemoryStore(), { name: 'demo', files: [{ path: 'a.txt', content: 'A' }, { path: 'b.txt', content: 'B' }] });
  const seen = [];
  const replies = [
    { content: '', tool_calls: [
      { id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      { id: 'call_0', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
      { id: '', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }
    ] },
    { content: 'Done.', tool_calls: [] }
  ];
  const agent = new Agent({ getConfig: () => ({ mode: 'edits' }), getContext: () => ({ workspace: ws }), approve: async () => true, onEvent: () => {},
    chatImpl: async (_config, request) => { seen.push(request.messages.map((m) => ({ ...m }))); return replies[Math.min(seen.length - 1, replies.length - 1)]; } });
  assert.equal(await agent.send('read both'), 'Done.');
  const history = seen[1];
  const assistant = history.find((m) => m.role === 'assistant' && m.tool_calls);
  const ids = assistant.tool_calls.map((c) => c.id);
  assert.equal(new Set(ids).size, 3);
  assert.equal(ids[0], 'call_0');
  const results = history.filter((m) => m.role === 'tool');
  assert.deepEqual(results.map((m) => m.tool_call_id), ids);
});
