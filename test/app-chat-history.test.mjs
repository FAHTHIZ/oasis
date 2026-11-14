// Browser chats are saved whole, and a chat saved by an older version (cut to
// its last 300 messages) loads without a tool result whose call was cut off.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Agent, answeredHistory } from '../app/core/agent.mjs';

test('tool results that answer no earlier call are dropped on load', () => {
  const messages = [
    { role: 'tool', tool_call_id: 'gone', content: 'orphan' },
    { role: 'user', content: 'next' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'kept' }
  ];
  assert.deepEqual(answeredHistory(messages).map((m) => m.content), ['next', '', 'kept']);
  const agent = new Agent({});
  agent.load([{ role: 'system', content: 's' }, ...messages]);
  assert.equal(agent.messages[0].role, 'user');
  assert.equal(agent.messages.length, 3);
});

test('the app saves the whole chat and the whole chat list', async () => {
  const source = await readFile(new URL('../app/main.mjs', import.meta.url), 'utf8');
  assert.equal(/agent\.messages\.slice\(-300\)/.test(source), false);
  assert.equal(/display: display\.slice\(-200\)/.test(source), false);
  assert.equal(/index\.list[^\n]*\.slice\(0, 50\)/.test(source), false);
});
