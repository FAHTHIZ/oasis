// Regressions found driving the TUI against a scripted model:
// - the edit view showed only the replaced fragment ("- a - b"), not the
//   changed lines with their numbers;
// - `node -e "import('./math.mjs')..."` exiting 0 after an edit still left
//   "no relevant test ... has passed" and a diff-review round trip that made
//   the model repeat its answer;
// - word-wrapped notices kept the break space on the third row (" verified").
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeEdit, editHunk } from '../src/terminal-ui.mjs';
import { renderDiff, wrapRendered } from '../src/markdown.mjs';
import { markRanSources, verificationIssues } from '../src/turn-guards.mjs';

test('the edit view shows whole changed lines with file line numbers and context', () => {
  const file = 'export function add(a, b) {\n  return a + b;\n}\n';
  const shown = describeEdit({ name: 'edit_file', args: { path: 'math.mjs', old_string: 'a - b', new_string: 'a + b' }, result: { changed: true } }, { color: false, fileText: file });
  assert.equal(shown, [
    '  ⎿ Updated math.mjs with 1 addition and 1 removal',
    '    1   export function add(a, b) {',
    '    2 -   return a - b;',
    '    2 +   return a + b;',
    '    3   }'
  ].join('\n'));
});

test('editHunk falls back when the new text is missing or appears more than once', () => {
  assert.equal(editHunk('y y', 'x', 'y'), null);
  assert.equal(editHunk('abc', 'x', 'zzz'), null);
  assert.equal(editHunk('abc', 'x', ''), null);
  const plain = describeEdit({ name: 'edit_file', args: { path: 'f', old_string: 'x', new_string: 'y' }, result: { changed: true } }, { color: false, fileText: 'y y' });
  assert.match(plain, /^ {4}- x$/m);
  // Without file text the fragment view is unchanged.
  assert.match(describeEdit({ name: 'edit_file', args: { path: 'f', old_string: 'x', new_string: 'y' }, result: { changed: true } }, { color: false }), /^ {4}\+ y$/m);
});

test('renderDiff numbers rows with old numbers for removals and new numbers otherwise', () => {
  const { text } = renderDiff('a\nb\nc', 'a\nB\nB2\nc', { color: false, startLine: 9 });
  assert.deepEqual(text.split('\n'), ['     9   a', '    10 - b', '    10 + B', '    11 + B2', '    12   c']);
});

test('inline code that imports a changed file and exits 0 counts as running it', () => {
  const state = { changedPaths: new Set(['math.mjs']), overwrittenPaths: new Set(), diffReviewedPaths: new Set(), lastVerificationExitCode: null };
  assert.ok(verificationIssues(state).some((issue) => /no relevant test/.test(issue)));
  markRanSources(state, 'node', ['-e', "import('./math.mjs').then((m) => console.log(m.add(2, 3)))"], 0);
  assert.deepEqual(verificationIssues(state), [], 'neither the check gate nor the diff review remains for a targeted edit');
  // Overwritten files still need their diff reviewed.
  const overwritten = { changedPaths: new Set(['math.mjs']), overwrittenPaths: new Set(['math.mjs']), diffReviewedPaths: new Set(), lastVerificationExitCode: null };
  markRanSources(overwritten, 'node', ['math.mjs'], 0);
  assert.ok(verificationIssues(overwritten).some((issue) => /diff has not been reviewed/.test(issue)));
});

test('inline code counts only when it names the file and exits 0', () => {
  const ran = (command, args, exitCode = 0, changed = ['math.mjs', 'pkg/parser.py']) => {
    const state = { changedPaths: new Set(changed) };
    markRanSources(state, command, args, exitCode);
    return [...(state.ranPaths || [])].sort();
  };
  assert.deepEqual(ran('node', ['-e', "console.log('mathXmjs')"]), []);
  assert.deepEqual(ran('node', ['-e', "import('./math.mjs')"], 1), []);
  assert.deepEqual(ran('node', ['--eval', 'require("./math.mjs")']), ['math.mjs']);
  assert.deepEqual(ran('python3', ['-c', 'from pkg.parser import parse; print(parse("1"))']), ['pkg/parser.py']);
  assert.deepEqual(ran('python3', ['-c', 'import pkg.parserx']), []);
});

test('wrapped rows never start with the break space', () => {
  const text = 'LSP verification unavailable for math.mjs: no typescript language server installed (npm install -g typescript-language-server typescript). Project checks are reported separately; this change was not verified by a language server.';
  const rows = wrapRendered(text, 100).split('\n');
  assert.ok(rows.length >= 3);
  for (const row of rows) assert.ok(!row.startsWith(' '), JSON.stringify(row));
});
