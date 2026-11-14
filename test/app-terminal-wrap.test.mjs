import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapWords } from '../app/core/terminal.mjs';

test('terminal notes wrap at spaces, never inside a word', () => {
  const hint = 'Press Enter or select Start terminal to open a shell in this project.';
  // 48 columns: the side panel width at which xterm split "shel|l".
  const rows = wrapWords(hint, 48);
  assert.deepEqual(rows, ['Press Enter or select Start terminal to open a', 'shell in this project.']);
  for (const row of rows) assert.ok(row.length <= 47);
  assert.equal(rows.join(' '), hint);
  assert.deepEqual(wrapWords(hint, 200), [hint]);
  assert.deepEqual(wrapWords('a ' + 'x'.repeat(40) + ' b', 20), ['a', 'x'.repeat(40), 'b'], 'a word longer than the row keeps its own row');
});
