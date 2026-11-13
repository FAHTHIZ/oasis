import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { readInput, searchPreview, createEditorState, applyKey } from '../src/line-editor.mjs';

test('Ctrl+R previews the matching history entry with the cursor on the match', () => {
  let state = createEditorState({ history: ['run the tests', 'fix the build'] });
  state = applyKey(state, { name: 'search' }).state;
  assert.equal(searchPreview(state), null);
  state = applyKey(state, { name: 'char', text: 'the b' }).state;
  assert.deepEqual(searchPreview(state), { text: 'fix the build', cursor: 4 });
});

test('readInput draws the Ctrl+R match in the prompt while searching', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.columns = 80;
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  const done = readInput({ input, output, color: false, prompt: '> ', history: ['deploy staging', 'run lint'], keybindings: false });
  input.write('\x12');
  input.write('stag');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const lastFrame = rendered.slice(rendered.lastIndexOf('\x1b[J'));
  assert.match(lastFrame, /> deploy staging/);
  assert.match(lastFrame, /\(reverse-i-search\) stag/);
  input.write('\r');
  input.write('\r');
  assert.deepEqual(await done, { type: 'submit', text: 'deploy staging' });
});
