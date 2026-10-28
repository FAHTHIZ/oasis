import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { applyVimKey, createVimState, trackInsert, vimModeLabel } from '../src/vim-mode.mjs';
import { applyKey, createEditorState, readInput } from '../src/line-editor.mjs';

// Feeds keys the way readInput does: vim first, else the normal editor + insert tracking.
function run(text, keys, { cursor, mode = 'normal', history = [] } = {}) {
  let state = createEditorState({ text, history });
  state.vim = createVimState(mode);
  if (cursor !== undefined) state.cursor = cursor;
  else if (mode === 'normal') state.cursor = Math.max(0, text.length - 1);
  const actions = [];
  for (const key of keys) {
    let outcome = applyVimKey(state, key);
    if (!outcome) { outcome = applyKey(state, key); outcome = { ...outcome, state: trackInsert(state, outcome.state) }; }
    state = outcome.state;
    if (outcome.action) actions.push(outcome.action);
  }
  return { state, actions };
}
const chars = (s) => [...s].map((c) => ({ name: 'char', text: c }));
const ESC = { name: 'escape' };

test('Esc enters NORMAL, i/a/A/I/o/O return to INSERT', () => {
  let { state } = run('hello', [ESC], { mode: 'insert', cursor: 5 });
  assert.equal(state.vim.mode, 'normal');
  assert.equal(state.cursor, 4);
  assert.equal(vimModeLabel(state), '-- NORMAL --');
  ({ state } = run('hello', [...chars('0A'), ...chars('!')]));
  assert.equal(state.text, 'hello!');
  assert.equal(vimModeLabel(state), '-- INSERT --');
  ({ state } = run('  hi', [...chars('I'), ...chars('>')]));
  assert.equal(state.text, '  >hi');
  ({ state } = run('one', [...chars('o'), ...chars('two')]));
  assert.equal(state.text, 'one\ntwo');
  ({ state } = run('two', [...chars('O'), ...chars('one')]));
  assert.equal(state.text, 'one\ntwo');
});

test('motions: w b e W 0 ^ $ f t ; , gg G', () => {
  const text = 'foo.bar baz qux';
  const at = (keys, cursor = 0) => run(text, chars(keys), { cursor }).state.cursor;
  assert.equal(at('w'), 3);
  assert.equal(at('W'), 8);
  assert.equal(at('2w'), 4);
  assert.equal(at('e'), 2);
  assert.equal(at('b', 8), 4);
  assert.equal(at('$'), text.length - 1);
  assert.equal(at('0', 9), 0);
  assert.equal(run('   x', chars('^'), { cursor: 0 }).state.cursor, 3);
  assert.equal(at('fz'), 10);
  assert.equal(at('tz'), 9);
  assert.equal(at('fa;'), 9);
  assert.equal(at('fa;,'), 5);
  assert.equal(run('a\nb\nc', chars('G'), { cursor: 0 }).state.cursor, 4);
  assert.equal(run('a\nb\nc', chars('gg'), { cursor: 4 }).state.cursor, 0);
});

test('operators with motions and counts: dw d2w cw de d$ D C x X', () => {
  const t = (text, keys, cursor = 0) => run(text, chars(keys), { cursor }).state;
  assert.equal(t('one two three', 'dw').text, 'two three');
  assert.equal(t('one two three', 'd2w').text, 'three');
  assert.equal(t('one two three', '2dw').text, 'three');
  const changed = t('one two three', 'cwONE');
  assert.equal(changed.text, 'ONE two three');
  assert.equal(changed.vim.mode, 'insert');
  assert.equal(t('one two', 'de').text, ' two');
  assert.equal(t('one two', 'd$', 3).text, 'one');
  assert.equal(t('one two', 'D', 3).text, 'one');
  assert.equal(t('one two', 'CX', 4).text, 'one X');
  assert.equal(t('abc', 'x').text, 'bc');
  assert.equal(t('abc', '2x').text, 'c');
  assert.equal(t('abc', 'X', 2).text, 'ac');
  assert.equal(t('a, b, c', 'dt,', 3).text, 'a, , c');
  assert.equal(t('a, b, c', 'df,', 3).text, 'a,  c');
});

test('line operators: dd 2dd cc yy p P J', () => {
  const t = (text, keys, cursor = 0) => run(text, chars(keys), { cursor }).state;
  assert.equal(t('a\nb\nc', 'dd', 2).text, 'a\nc');
  assert.equal(t('a\nb\nc', 'dd', 4).text, 'a\nb');
  assert.equal(t('a\nb\nc', '2dd').text, 'c');
  const cc = t('a\nbbb\nc', 'ccX', 2);
  assert.equal(cc.text, 'a\nX\nc');
  assert.equal(t('a\nb', 'yyp').text, 'a\na\nb');
  assert.equal(t('a\nb', 'yyjP').text, 'a\na\nb');
  assert.equal(t('a\nb', 'ddp').text, 'b\na');
  assert.equal(t('hello\n   world', 'J').text, 'hello world');
});

test('text objects: ciw, daw, ci", da(, di{', () => {
  const t = (text, keys, cursor) => run(text, chars(keys), { cursor }).state;
  assert.equal(t('say hello world', 'ciwbye', 5).text, 'say bye world');
  assert.equal(t('say hello world', 'daw', 5).text, 'say world');
  assert.equal(t('call("old value")', 'ci"new', 8).text, 'call("new")');
  assert.equal(t('fn(a, (b))', 'da(', 4).text, 'fn');
  assert.equal(t('fn(a, (b))', 'di(', 7).text, 'fn(a, ())');
  assert.equal(t('x = { a: 1 }', 'di{', 6).text, 'x = {}');
  assert.equal(t("it's 'quoted' here", "di'", 8).text, "it's '' here");
});

test('r ~ u p and the yank register', () => {
  const t = (text, keys, cursor = 0) => run(text, chars(keys), { cursor }).state;
  assert.equal(t('cat', 'rb').text, 'bat');
  assert.equal(t('cat', '3rx').text, 'xxx');
  assert.equal(t('abc', '~~').text, 'ABc');
  assert.equal(t('one two', 'dwu').text, 'one two');
  assert.equal(t('one two', 'ywP').text, 'one one two');
  assert.equal(t('ab', 'xp').text, 'ba');
});

test('. repeats the last change, including typed text', () => {
  const t = (text, keys, cursor = 0) => run(text, keys, { cursor }).state;
  assert.equal(t('a b c d', chars('dw..')).text, 'd');
  assert.equal(t('foo foo foo', [...chars('cwbar'), ESC, ...chars('w.w.')]).text, 'bar bar bar');
  assert.equal(t('x', [...chars('A!'), ESC, ...chars('.')]).text, 'x!!');
});

test('Enter submits from NORMAL; j/k walk history at the edges; Esc in NORMAL passes through', () => {
  let { actions } = run('hi', [{ name: 'enter' }]);
  assert.deepEqual(actions, ['submit']);
  let { state } = run('', chars('k'), { history: ['first', 'second'], cursor: 0 });
  assert.equal(state.text, 'second');
  ({ state } = run('', chars('kkj'), { history: ['first', 'second'], cursor: 0 }));
  assert.equal(state.text, 'second');
  ({ actions } = run('hi', [ESC]));
  assert.deepEqual(actions, ['escape'], 'double-Esc rewind still works from NORMAL');
  ({ state, actions } = run('hi', [...chars('d'), ESC]));
  assert.equal(state.vim.pending, '');
  assert.deepEqual(actions, []);
});

test('readInput with vim: true edits in NORMAL mode and shows the mode', async () => {
  const input = new PassThrough();
  input.isTTY = true;
  input.setRawMode = () => {};
  const output = new PassThrough();
  output.columns = 80;
  let rendered = '';
  output.on('data', (chunk) => { rendered += chunk; });
  const done = readInput({ input, output, vim: true, color: false, prompt: '> ' });
  input.write('hello world');
  input.write('\x1b');
  await new Promise((resolve) => setTimeout(resolve, 20));
  input.write('0dw');
  input.write('\r');
  const result = await done;
  assert.equal(result.text, 'world');
  assert.match(rendered, /-- INSERT --/);
  assert.match(rendered, /-- NORMAL --/);
});

test('/vim toggles and persists editorMode in user settings', async (t) => {
  const os = await import('node:os');
  const path = await import('node:path');
  const { mkdtemp, readFile, rm } = await import('node:fs/promises');
  const { runBuiltinCommand } = await import('../src/slash.mjs');
  const { loadSettings } = await import('../src/settings.mjs');
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-vim-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const sessionOptions = {};
  const on = await runBuiltinCommand('vim', '', { root: home, env, sessionOptions });
  assert.match(on.output, /Vim mode on/);
  assert.equal(sessionOptions.editorMode, 'vim');
  assert.equal(JSON.parse(await readFile(path.join(env.OASIS_CONFIG_DIR, 'settings.json'), 'utf8')).editorMode, 'vim');
  assert.equal((await loadSettings(home, { env })).editorMode, 'vim');
  const off = await runBuiltinCommand('vim', 'off', { root: home, env, sessionOptions });
  assert.match(off.output, /off/);
  assert.equal(sessionOptions.editorMode, 'normal');
});
