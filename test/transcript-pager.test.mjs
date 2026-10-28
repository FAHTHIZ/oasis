import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readInput, stripAnsi } from '../src/line-editor.mjs';
import { transcriptLines } from '../src/terminal-ui.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

test('transcriptLines expands prompts, tool calls and results', () => {
  const lines = transcriptLines([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'fix the bug' },
    { role: 'assistant', content: 'Looking.', tool_calls: [{ id: 'a', function: { name: 'read_file', arguments: '{"path":"x.js"}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'const x = 1;' },
    { role: 'tool', tool_call_id: 'b', content: '{"error":"nope"}' },
    { role: 'assistant', content: 'Done.' }
  ], { color: false, width: 60 });
  const text = lines.join('\n');
  assert.doesNotMatch(text, /sys/);
  assert.match(text, /> You\n  fix the bug/);
  assert.match(text, /⏺ read_file\n    \{\n      "path": "x.js"/);
  assert.match(text, /⎿ result\n    const x = 1;/);
  assert.match(text, /⎿ error/);
  assert.match(text, /● Oasis\n  Done\./);
});

test('Ctrl+O opens a full-screen pager and q returns to the prompt', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.columns = 80;
  output.rows = 6;
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  const lines = Array.from({ length: 30 }, (_, i) => 'line ' + (i + 1));
  const done = readInput({ input, output, prompt: '> ', color: false, onTranscript: async () => ({ pager: lines }) });
  await tick();
  input.write('\x0f');
  await tick();
  assert.match(rendered, /\x1b\[\?1049h/);
  assert.match(stripAnsi(rendered), /line 30/);
  assert.match(stripAnsi(rendered), /transcript 26-30 of 30/);
  input.write('g');
  await tick();
  assert.match(stripAnsi(rendered), /transcript 1-5 of 30/);
  input.write('hi');
  await tick();
  input.write('q');
  await tick();
  assert.match(rendered, /\x1b\[\?1049l/);
  input.write('ok\r');
  const result = await done;
  assert.equal(result.text, 'ok');
});
