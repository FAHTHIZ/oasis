import test from 'node:test';
import assert from 'node:assert/strict';
import { savedSessionDisplay } from '../src/web.mjs';
import { buildTimeline } from '../app/core/timeline.mjs';

test('a saved session reopens with its steps, not only the prose', () => {
  const messages = [
    { role: 'system', content: 'You are OASIS' },
    { role: 'user', content: 'fix add()' },
    { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"math.mjs"}' } }] },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: '{"path":"math.mjs","content":"x"}' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c2', type: 'function', function: { name: 'run_command', arguments: '{"command":"npm","args":["test"],"env":{"API_KEY":"sk-ant-abcdefghijklmnopqrstuvwxyz0123456789"}}' } }] },
    { role: 'tool', tool_call_id: 'c2', name: 'run_command', content: '{"exitCode":1,"stdout":"fail"}' },
    { role: 'user', content: '<system-reminder>verify</system-reminder>' },
    { role: 'assistant', content: 'Done.' }
  ];
  const display = savedSessionDisplay(messages);
  assert.deepEqual(display.map((entry) => entry.role), ['user', 'assistant', 'assistant', 'assistant']);
  assert.equal(display[1].tools[0].name, 'read_file');
  assert.equal(display[1].tools[0].ok, true);
  assert.equal(display[2].tools[0].ok, false, 'a failed command stays failed');
  assert.doesNotMatch(JSON.stringify(display), /sk-ant-abcdefghij/, 'secrets in arguments are redacted');
  const kinds = buildTimeline(display).map((block) => block.type);
  assert.deepEqual(kinds, ['user', 'text', 'group', 'text']);
});

// Reopened chats showed long replies cut at 24,000 characters.
test('a reopened chat shows a long reply in full', () => {
  const long = 'Long answer line.\n'.repeat(3000) + 'REPLY-END';
  const display = savedSessionDisplay([{ role: 'user', content: 'write it all' }, { role: 'assistant', content: long }]);
  assert.equal(display.at(-1).content, long);
});
