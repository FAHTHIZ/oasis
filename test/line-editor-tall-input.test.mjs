import test from 'node:test';
import assert from 'node:assert/strict';
import { layoutFrame } from '../src/line-editor.mjs';

const text = Array.from({ length: 400 }, (_, i) => 'line ' + i).join('\n');
const rowsOf = (frame) => frame.out.split('\r\n');

test('a tall input draws only a window around the cursor with more-lines markers', () => {
  const end = layoutFrame({ prompt: '> ', continuation: '… ', text, cursor: text.length, maxLines: 10 });
  const rows = rowsOf(end);
  assert.ok(rows.length <= 10);
  assert.equal(rows[0], '> [392 more lines above]');
  assert.equal(rows.at(-1), '… line 399');
  assert.equal(end.cursorRow, rows.length - 1);
  assert.equal(end.cursorCol, '… line 399'.length);

  const start = layoutFrame({ prompt: '> ', continuation: '… ', text, cursor: 3, maxLines: 10 });
  assert.equal(rowsOf(start)[0], '> line 0');
  assert.equal(rowsOf(start).at(-1), '… [392 more lines below]');
  assert.equal(start.cursorRow, 0);
  assert.equal(start.cursorCol, 5);

  const middle = text.indexOf('line 200') + 4;
  const mid = layoutFrame({ prompt: '> ', continuation: '… ', text, cursor: middle, maxLines: 10, hints: ['hint'] });
  const midRows = rowsOf(mid);
  assert.match(midRows[0], /more lines above/);
  assert.match(midRows.at(-2), /more lines below/);
  assert.equal(midRows.at(-1), 'hint');
  assert.equal(midRows[mid.cursorRow], '… line 200');
});

test('short input and the default are unchanged', () => {
  const frame = layoutFrame({ prompt: '> ', continuation: '… ', text: 'a\nb', cursor: 3, maxLines: 10 });
  assert.equal(frame.out, '> a\r\n… b');
  assert.equal(rowsOf(layoutFrame({ prompt: '> ', continuation: '… ', text, cursor: 0 })).length, 400);
});
