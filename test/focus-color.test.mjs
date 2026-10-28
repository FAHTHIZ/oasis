import test from 'node:test';
import assert from 'node:assert/strict';
import { focusView, promptFor, setPromptColor } from '../src/terminal-ui.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

test('/color changes the prompt glyph color and validates names', async () => {
  const state = { root: '.', env: process.env, sessionOptions: {} };
  assert.match((await runBuiltinCommand('color', 'red', state)).output, /set to red/);
  assert.match(promptFor('hi', true), /38;2;239;68;68/);
  assert.match((await runBuiltinCommand('color', 'mauve', state)).output, /Unknown color/);
  assert.match((await runBuiltinCommand('color', 'random', state)).output, /set to (?!red)/);
  await runBuiltinCommand('color', 'default', state);
  assert.doesNotMatch(promptFor('hi', true), /239;68;68/);
  setPromptColor('default');
});

test('/focus summarizes the last turn with edit stats', async () => {
  const messages = [
    { role: 'system', content: 's' },
    { role: 'user', content: 'old prompt' },
    { role: 'assistant', content: 'old reply' },
    { role: 'user', content: 'fix the bug' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'a', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'src/x.js', old_string: 'a\nb', new_string: 'a\nb\nc' }) } },
      { id: 'b', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'npm', args: ['test'] }) } }
    ] },
    { role: 'tool', tool_call_id: 'a', content: '{"ok":true}' },
    { role: 'tool', tool_call_id: 'b', content: '{"error":"failed"}' },
    { role: 'assistant', content: 'Fixed it.' }
  ];
  const view = focusView(messages, { color: false });
  assert.match(view, /fix the bug/);
  assert.doesNotMatch(view, /old prompt/);
  assert.match(view, /• edit_file src\/x\.js \+3 -2/);
  assert.match(view, /✗ run_command npm test/);
  assert.match(view, /Fixed it\./);
  const handled = await runBuiltinCommand('focus', '', { root: '.', env: process.env, session: { messages } });
  assert.match(handled.focus, /Tools \(2\)/);
});
