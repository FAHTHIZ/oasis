import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readInput, stripAnsi } from '../src/line-editor.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// The banner promises "? shortcuts": typing ? on an empty prompt shows them right away, and the
// next key keeps typing a normal message that starts with ?.
test('? on an empty prompt shows the shortcuts without swallowing the text', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.columns = 100;
  output.rows = 30;
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  const done = readInput({ input, output, prompt: '> ', color: false });
  input.write('?'); await tick();
  assert.match(stripAnsi(rendered), /Shift\+Tab cycle permission mode/);
  rendered = '';
  for (const ch of ' why') { input.write(ch); await tick(); }
  assert.doesNotMatch(stripAnsi(rendered).slice(-200), /Shift\+Tab cycle permission mode/);
  input.write('\r');
  assert.equal((await done).text, '? why');
});
