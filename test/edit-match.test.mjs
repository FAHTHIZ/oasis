import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { relaxedReplace, closestMatchHint } from '../src/edit-match.mjs';
import { executeTool } from '../src/tools.mjs';

test('relaxed match tolerates trailing whitespace and CRLF', () => {
  const file = 'function a() {   \r\n  return 1;\r\n}\r\n';
  const out = relaxedReplace(file, 'function a() {\n  return 1;\n}', 'function a() {\n  return 2;\n}');
  assert.ok(out);
  assert.equal(out.next, 'function a() {\r\n  return 2;\r\n}\r\n');
});

test('relaxed match tolerates smart quotes', () => {
  const file = "const s = 'hello';\n";
  const out = relaxedReplace(file, 'const s = \u2018hello\u2019;', "const s = 'bye';");
  assert.equal(out.next, "const s = 'bye';\n");
  assert.equal(out.strategy, 'typographic quotes');
});

test('relaxed match re-indents replacement on indentation-only mismatch', () => {
  const file = 'class A {\n    run() {\n        go();\n    }\n}\n';
  const out = relaxedReplace(file, 'run() {\n    go();\n}', 'run() {\n    stop();\n}');
  assert.equal(out.strategy, 'indentation');
  assert.equal(out.next, 'class A {\n    run() {\n        stop();\n    }\n}\n');
});

test('relaxed match refuses ambiguous candidates', () => {
  const file = 'x = 1  \nx = 1\t\n';
  assert.equal(relaxedReplace(file, 'x = 1', 'x = 2'), null);
});

test('closest match hint shows the real text with line numbers', () => {
  const file = 'a\nb\nfunction computeTotal(items) {\n  return items.length;\n}\n';
  const hint = closestMatchHint(file, 'function computeTotals(item) {\n  return items.size;\n}');
  assert.match(hint, /starts at line 3/);
  assert.match(hint, /3\| function computeTotal\(items\)/);
});

test('edit_file applies a unique relaxed match and reports how it matched', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-editmatch-'));
  try {
    await writeFile(path.join(root, 'a.js'), 'if (ok) {   \n  run();\n}\n');
    const result = await executeTool('edit_file', { path: 'a.js', old_string: 'if (ok) {\n  run();\n}', new_string: 'if (ok) {\n  walk();\n}' }, { root });
    assert.equal(result.changed, true);
    assert.equal(result.matchedBy, 'line endings and trailing whitespace');
    assert.equal(await readFile(path.join(root, 'a.js'), 'utf8'), 'if (ok) {\n  walk();\n}\n');
    await assert.rejects(
      executeTool('edit_file', { path: 'a.js', old_string: 'if (okay) {\n  walking();\n}', new_string: 'x' }, { root }),
      /Closest match .* line 1/s
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('multi_edit uses relaxed matching and the elision guard', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-multiedit-'));
  try {
    await writeFile(path.join(root, 'b.js'), 'const a = 1;   \nconst b = 2;\n');
    const result = await executeTool('multi_edit', { path: 'b.js', edits: [
      { old_string: 'const a = 1;', new_string: 'const a = 10;' },
      { old_string: 'const b = 2;  ', new_string: 'const b = 20;' }
    ] }, { root });
    assert.equal(result.changed, true);
    assert.match(result.note || '', /Edit 2 matched/);
    assert.equal(await readFile(path.join(root, 'b.js'), 'utf8'), 'const a = 10;   \nconst b = 20;\n');
    await assert.rejects(
      executeTool('multi_edit', { path: 'b.js', edits: [{ old_string: 'const a = 10;', new_string: '// ... rest of the code unchanged' }] }, { root }),
      /placeholder/
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('relaxed quote matches keep the file’s typographic quotes, dashes and NBSPs outside the changed span', () => {
  const file = 'const msg = “Don’t stop” — ok;\nconst b = ‘x’;\nconst price = 5\u00A0€;\nconst c = 1;\n';
  const result = relaxedReplace(file,
    'const msg = "Don\'t stop" - ok;\nconst b = \'x\';\nconst price = 5 €;\nconst c = 1;',
    'const msg = "Don\'t stop now" - ok;\nconst b = \'x\';\nconst price = 5 €;\nconst c = 2;');
  assert.equal(result.strategy, 'typographic quotes');
  assert.equal(result.next, 'const msg = “Don’t stop now” — ok;\nconst b = ‘x’;\nconst price = 5\u00A0€;\nconst c = 2;\n');
});

test('typography is kept when lines are added, and new text the model typed stays as typed', () => {
  const file = '  <p>It’s “here”.</p>\n  <p>End</p>\n';
  const result = relaxedReplace(file, '<p>It\'s "here".</p>\n<p>End</p>', '<p>It\'s "here".</p>\n<p>New "line"</p>\n<p>End</p>');
  assert.equal(result.strategy, 'indentation');
  assert.equal(result.next, '  <p>It’s “here”.</p>\n  <p>New "line"</p>\n  <p>End</p>\n');
});

test('ASCII-only files are untouched by typography restoration', () => {
  const result = relaxedReplace('a = "x"  \nb = 1\n', 'a = "x"\nb = 1', 'a = "y"\nb = 1');
  assert.equal(result.next, 'a = "y"\nb = 1\n');
});

test('write_file warns when a rewrite flattens typographic quotes into ASCII', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-typo-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'copy.md'), '# Welcome\n\nIt’s “easy” — really.\nPlain line.\n');
  const flattened = await executeTool('write_file', { path: 'copy.md', content: '# Welcome\n\nIt\'s "easy" - really.\nPlain line.\nNew line.\n' }, { root, autoApprove: true });
  assert.match(flattened.warning, /Typography changed: 1 line\(s\) in copy\.md lost their curly quotes/);
  const kept = await executeTool('write_file', { path: 'copy.md', content: '# Welcome\n\nIt\'s "easy" - really.\nPlain line.\nNew line 2.\n' }, { root, autoApprove: true });
  assert.ok(!kept.warning || !/Typography/.test(kept.warning), 'no warning once the file is ASCII');
  await writeFile(path.join(root, 'copy.md'), 'It’s “easy”.\n');
  const reworded = await executeTool('write_file', { path: 'copy.md', content: 'Completely different text.\n' }, { root, autoApprove: true });
  assert.ok(!reworded.warning || !/Typography/.test(reworded.warning), 'rewording is not flattening');
});
