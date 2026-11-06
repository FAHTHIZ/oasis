import test from 'node:test';
import assert from 'node:assert/strict';
import { maskObservations } from '../src/context.mjs';

function conversation(turns) {
  const messages = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'task' }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'f' + i + '.js' }) } }] });
    messages.push({ role: 'tool', tool_call_id: 'c' + i, name: 'read_file', content: ('file ' + i + ' ').repeat(200) });
  }
  return messages;
}

test('observation masking keeps the last N turns and stubs older tool output', () => {
  const messages = conversation(12);
  const { messages: out, masked } = maskObservations(messages, { keepTurns: 4, batch: 1 });
  assert.equal(masked, 8);
  const tools = out.filter((m) => m.role === 'tool');
  assert.match(tools[0].content, /^\[Older tool output compacted/);
  assert.match(out[2].tool_calls[0].function.arguments, /f0\.js/, 'the call that produced it stays visible');
  assert.equal(tools[8].content, messages.filter((m) => m.role === 'tool')[8].content);
  assert.equal(tools.filter((m) => m.content.startsWith('[Older')).length, 8);
  assert.notEqual(out, messages);
  assert.match(messages[3].content, /^file 0/, 'input is not mutated');
});

test('observation masking waits for a full batch so the cached prefix breaks rarely', () => {
  const messages = conversation(6);
  assert.equal(maskObservations(messages, { keepTurns: 4, batch: 4 }).masked, 0);
  const once = maskObservations(conversation(8), { keepTurns: 4, batch: 4 });
  assert.equal(once.masked, 4);
  // Already-masked outputs are not counted again.
  const next = maskObservations([...once.messages, ...conversation(1).slice(2)], { keepTurns: 4, batch: 4 });
  assert.equal(next.masked, 0);
});

test('observation masking skips short outputs and the todo list, and is off without a window', () => {
  const messages = conversation(6);
  messages[3] = { ...messages[3], content: 'short' };
  messages[5] = { ...messages[5], name: 'todo_write' };
  assert.equal(maskObservations(messages, { keepTurns: 2, batch: 1 }).masked, 2);
  assert.equal(maskObservations(messages, { keepTurns: 0 }).masked, 0);
});
