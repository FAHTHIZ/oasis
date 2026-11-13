import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditorState, applyKey } from '../src/line-editor.mjs';
import { applyVimKey, createVimState } from '../src/vim-mode.mjs';
import { prevGrapheme, nextGrapheme, indexAtColumn } from '../src/text-cursor.mjs';

const press = (state, ...names) => { for (const name of names) state = applyKey(state, typeof name === 'string' ? { name } : name).state; return state; };
const at = (text, cursor) => ({ ...createEditorState({ text }), cursor: cursor ?? text.length });

test('arrows, Backspace and Delete step over whole emoji and combining marks', () => {
  const family = '👨‍👩‍👧';
  const flag = '🇯🇵';
  const thumbs = '👍🏽';
  const accent = 'e\u0301';
  for (const cluster of [family, flag, thumbs, accent, '한']) {
    const text = 'a' + cluster + 'b';
    assert.equal(press(at(text, 1 + cluster.length), 'left').cursor, 1, cluster);
    assert.equal(press(at(text, 1), 'right').cursor, 1 + cluster.length, cluster);
    assert.equal(press(at(text, 1 + cluster.length), 'backspace').text, 'ab', cluster);
    assert.equal(press(at(text, 1), 'delete').text, 'ab', cluster);
  }
  assert.equal(prevGrapheme('x\n' + family, 2), 1);
  assert.equal(nextGrapheme(family + '\n', family.length), family.length + 1);
});

test('word motions stop at punctuation and split CJK into words', () => {
  const text = 'open src/line-editor.mjs now';
  let state = at(text);
  state = press(state, 'wordLeft');
  assert.equal(state.cursor, text.indexOf('now'));
  state = press(state, 'wordLeft');
  assert.equal(text.slice(state.cursor), 'mjs now');
  state = press(at(text, 0), 'wordRight');
  assert.equal(state.cursor, 4);
  // Ctrl+W still erases back to whitespace, like bash.
  assert.equal(press(at('open src/line-editor.mjs'), 'killWord').text, 'open ');
  const ja = '日本語のテキスト';
  const left = press(at(ja), 'wordLeft').cursor;
  assert.ok(left > 0 && left < ja.length, 'CJK word step lands inside the run');
  assert.equal(press(at('foo.bar', 0), 'deleteWord').text, '.bar');
});

test('Up/Down keep the display column over wide CJK lines', () => {
  const text = 'abcd\n日本語';
  // Cursor after "日" (2 columns) on line 2; Up lands after "ab".
  let state = at(text, 5 + 1);
  state = press(state, 'up');
  assert.equal(state.cursor, 2);
  // From column 3 on line 1, Down cannot split "本", so it stops before it.
  state = press({ ...state, cursor: 3 }, 'down');
  assert.equal(state.cursor, 6);
  assert.equal(indexAtColumn('日本', 0, 2, 4), 2);
});

test('vim h, l, x and X treat an emoji as one character', () => {
  const text = 'a😀b';
  let state = { ...at(text, 0), vim: createVimState('normal') };
  state = applyVimKey(state, { name: 'char', text: 'l' }).state;
  assert.equal(state.cursor, 1);
  state = applyVimKey(state, { name: 'char', text: 'l' }).state;
  assert.equal(state.cursor, 3);
  state = applyVimKey(state, { name: 'char', text: 'h' }).state;
  assert.equal(state.cursor, 1);
  state = applyVimKey(state, { name: 'char', text: 'x' }).state;
  assert.equal(state.text, 'ab');
  state = { ...at('a😀', 3), vim: createVimState('normal') };
  state = applyVimKey(state, { name: 'char', text: '$' }).state;
  assert.equal(state.cursor, 1, 'normal-mode cursor rests on the emoji, not inside it');
  state = { ...at('😀b', 2), vim: createVimState('normal') };
  state = applyVimKey(state, { name: 'char', text: 'X' }).state;
  assert.equal(state.text, 'b');
});

test('layout wraps a wide character that does not fit the last cell onto the next row', async () => {
  const { layoutFrame } = await import('../src/line-editor.mjs');
  // "> a日本語" fills 9 of 10 cells; "漢" needs 2, so the terminal moves it down.
  let frame = layoutFrame({ prompt: '> ', continuation: '  ', text: 'a日本語漢', cursor: 5, columns: 10 });
  assert.deepEqual([frame.cursorRow, frame.cursorCol, frame.endRow], [1, 2, 1]);
  frame = layoutFrame({ prompt: '> ', continuation: '  ', text: 'a日本語漢', cursor: 4, columns: 10 });
  assert.deepEqual([frame.cursorRow, frame.cursorCol], [0, 9]);
  // Exactly full row: cursor and the next line start on the following row.
  frame = layoutFrame({ prompt: '> ', continuation: '  ', text: '日本語漢\nx', cursor: 4, columns: 10, hints: ['h'] });
  assert.deepEqual([frame.cursorRow, frame.cursorCol, frame.endRow], [1, 0, 2]);
});
