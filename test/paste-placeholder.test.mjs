import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { applyKey, createEditorState, expandPastes, readInput } from '../src/line-editor.mjs';

const big = Array.from({ length: 30 }, (_, i) => 'line ' + i).join('\n');
const editor = () => ({ ...createEditorState(), pastes: {} });

test('a large paste shows as one placeholder and expands on demand', () => {
  let { state } = applyKey(editor(), { name: 'char', text: 'fix ' });
  ({ state } = applyKey(state, { name: 'paste', text: big }));
  assert.equal(state.text, 'fix [Pasted text #1 +30 lines]');
  ({ state } = applyKey(state, { name: 'paste', text: 'x'.repeat(1200) }));
  assert.equal(state.text, 'fix [Pasted text #1 +30 lines][Pasted text #2, 1200 chars]');
  assert.equal(expandPastes(state.text, state.pastes), 'fix ' + big + 'x'.repeat(1200));
  // Small pastes and text typed to look like a placeholder stay as they are.
  ({ state } = applyKey(state, { name: 'paste', text: 'a\nb' }));
  assert.ok(state.text.endsWith('chars]a\nb'));
  assert.equal(expandPastes('[Pasted text #9 +3 lines]', state.pastes), '[Pasted text #9 +3 lines]');
});

test('backspace and delete remove a placeholder whole', () => {
  let { state } = applyKey(editor(), { name: 'paste', text: big });
  ({ state } = applyKey(state, { name: 'char', text: '!' }));
  ({ state } = applyKey(state, { name: 'backspace' }));
  ({ state } = applyKey(state, { name: 'backspace' }));
  assert.equal(state.text, '');
  ({ state } = applyKey(state, { name: 'paste', text: big }));
  ({ state } = applyKey(state, { name: 'home' }));
  ({ state } = applyKey(state, { name: 'delete' }));
  assert.equal(state.text, '');
  // Editing inside the placeholder breaks it; it is then sent as typed.
  ({ state } = applyKey(state, { name: 'paste', text: big }));
  ({ state } = applyKey(state, { name: 'left' }));
  ({ state } = applyKey(state, { name: 'backspace' }));
  assert.equal(expandPastes(state.text, state.pastes), '[Pasted text #3 +30 line]');
});

test('readInput sends the full bracketed paste, CRLF normalized, while showing the placeholder', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.columns = 80;
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  const done = readInput({ input, output, color: false, prompt: '> ' });
  input.write('see \x1b[200~' + big.replace(/\n/g, '\r\n') + '\x1b[201~');
  input.write('\r');
  assert.equal((await done).text, 'see ' + big);
  assert.match(rendered, /\[Pasted text #1 \+30 lines\]/);
  assert.doesNotMatch(rendered, /line 29/);
});
