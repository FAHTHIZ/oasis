import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readInput, stripAnsi } from '../src/line-editor.mjs';

const tick = () => new Promise((resolve) => setTimeout(resolve, 20));

// Typing "@ad" lists matching files right away, like the slash-command menu,
// instead of showing nothing until Tab.
test('typing an @mention shows matching files before Tab', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.columns = 80;
  output.rows = 20;
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  const complete = async (text, cursor) => {
    const token = /@[^\s@]*$/.exec(text.slice(0, cursor));
    if (!token) return { candidates: [] };
    const files = ['add.mjs', 'src/adder.mjs', 'notes.md'].filter((file) => file.includes(token[0].slice(1)));
    return { start: token.index, end: cursor, candidates: files.map((file) => ({ value: '@' + file })) };
  };
  const done = readInput({ input, output, prompt: '> ', color: false, complete });
  for (const ch of 'explain @ad') { input.write(ch); await tick(); }
  const screen = stripAnsi(rendered);
  assert.match(screen, /Files · Tab to complete/);
  assert.match(screen, /@src\/adder\.mjs/);
  assert.doesNotMatch(screen.slice(screen.lastIndexOf('Files')), /notes/);
  rendered = '';
  input.write(' ok');
  await tick();
  input.write('\r');
  assert.equal((await done).text, 'explain @ad ok');
});
