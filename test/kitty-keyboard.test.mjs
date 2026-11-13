import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readInput, kittyKeyboard } from '../src/line-editor.mjs';

function tty() {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.columns = 80;
  let written = '';
  output.on('data', (chunk) => { written += chunk; });
  return { input, output, written: () => written };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 15));

test('the kitty keyboard protocol is asked for, pushed while the prompt is open and popped after', async () => {
  kittyKeyboard.supported = null;
  let t = tty();
  let done = readInput({ input: t.input, output: t.output, color: false, keybindings: false, env: { TERM: 'xterm-kitty' } });
  assert.match(t.written(), /\x1b\[\?u\x1b\[c/);
  t.input.write('\x1b[?0u\x1b[?62;22c');
  await tick();
  assert.match(t.written(), /\x1b\[>1u/);
  // Shift+Enter and Alt+B arrive as CSI-u; Esc as CSI 27 u.
  t.input.write('one\x1b[13;2utwo\x1b[98;3u\x1b[27u');
  await tick();
  t.input.write('\r');
  assert.deepEqual(await done, { type: 'submit', text: 'one\ntwo' });
  assert.ok(t.written().lastIndexOf('\x1b[<u') > t.written().lastIndexOf('\x1b[>1u'), 'flags popped when the prompt closes');
  assert.equal(kittyKeyboard.pushed, null);

  // Next prompt: known support, pushed at once without asking again.
  t = tty();
  done = readInput({ input: t.input, output: t.output, color: false, keybindings: false, env: { TERM: 'xterm-kitty' } });
  assert.doesNotMatch(t.written(), /\x1b\[\?u/);
  assert.match(t.written(), /\x1b\[>1u/);
  t.input.write('\x1b[99;5u');
  t.input.write('x\r');
  assert.deepEqual(await done, { type: 'submit', text: 'x' });
  kittyKeyboard.supported = null;
});

test('terminals without the protocol and OASIS_KITTY_KEYBOARD=0 stay on legacy keys', async () => {
  kittyKeyboard.supported = null;
  let t = tty();
  let done = readInput({ input: t.input, output: t.output, color: false, keybindings: false, env: { TERM: 'xterm' } });
  t.input.write('\x1b[?62;22c');
  await tick();
  t.input.write('a\r');
  assert.deepEqual(await done, { type: 'submit', text: 'a' });
  assert.doesNotMatch(t.written(), /\x1b\[>1u/);
  assert.equal(kittyKeyboard.supported, false);

  kittyKeyboard.supported = null;
  t = tty();
  done = readInput({ input: t.input, output: t.output, color: false, keybindings: false, env: { TERM: 'xterm-kitty', OASIS_KITTY_KEYBOARD: '0' } });
  t.input.write('b\r');
  assert.deepEqual(await done, { type: 'submit', text: 'b' });
  assert.doesNotMatch(t.written(), /\x1b\[\?u|\x1b\[>1u/);
  kittyKeyboard.supported = null;
});
