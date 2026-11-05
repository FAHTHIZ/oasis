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

function harness() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.columns = 80;
  output.rows = 20;
  const box = { rendered: '' };
  output.on('data', (chunk) => { box.rendered += chunk; });
  return { input, output, box };
}

test('arrow keys pick an @file from the live list and Enter inserts it', async () => {
  const { input, output, box } = harness();
  const complete = async (text, cursor) => {
    const token = /@[^\s@]*$/.exec(text.slice(0, cursor));
    if (!token) return { candidates: [] };
    return { start: token.index, end: cursor, candidates: ['add.mjs', 'src/adder.mjs'].filter((f) => f.includes(token[0].slice(1))).map((f) => ({ value: '@' + f })) };
  };
  const done = readInput({ input, output, prompt: '> ', color: false, complete });
  for (const ch of 'fix @ad') { input.write(ch); await tick(); }
  input.write('\x1b[B'); await tick();
  input.write('\x1b[B'); await tick();
  assert.match(stripAnsi(box.rendered), /↑↓ to pick/);
  input.write('\r'); await tick();
  input.write('now'); await tick();
  input.write('\r');
  assert.equal((await done).text, 'fix @src/adder.mjs now');
});

test('arrow keys pick a slash command and Enter runs it; Up without the menu is still history', async () => {
  const { input, output } = harness();
  const complete = async (text) => ({ start: 0, end: text.length, candidates: ['/clear', '/compact', '/context'].filter((c) => c.startsWith(text)).map((value) => ({ value })) });
  const done = readInput({ input, output, prompt: '> ', color: false, complete });
  for (const ch of '/c') { input.write(ch); await tick(); }
  input.write('\x1b[A'); await tick(); // wraps to the last entry
  input.write('\r');
  assert.equal((await done).text, '/context');

  const second = harness();
  const again = readInput({ input: second.input, output: second.output, prompt: '> ', color: false, complete, history: ['earlier prompt'] });
  second.input.write('\x1b[A'); await tick();
  second.input.write('\r');
  assert.equal((await again).text, 'earlier prompt');
});

test('Enter with no entry picked still submits what was typed', async () => {
  const { input, output } = harness();
  const complete = async (text) => ({ start: 0, end: text.length, candidates: ['/clear', '/compact'].filter((c) => c.startsWith(text)).map((value) => ({ value })) });
  const done = readInput({ input, output, prompt: '> ', color: false, complete });
  for (const ch of '/c') { input.write(ch); await tick(); }
  input.write('\r');
  assert.equal((await done).text, '/c');
});
