import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ambiguousMatchHint, relaxedReplace } from '../src/edit-match.mjs';
import { executeTool } from '../src/tools.mjs';

test('exact duplicates are reported with their line numbers', () => {
  const file = 'a();\nconst x = 1;\nb();\nconst x = 1;\nc();\n';
  const hint = ambiguousMatchHint(file, 'const x = 1;', 2);
  assert.match(hint, /line 2: const x = 1;/);
  assert.match(hint, /line 4: const x = 1;/);
  assert.match(hint, /replace_all=true/);
});

test('long duplicate lists are capped', () => {
  const file = Array.from({ length: 20 }, () => 'x = 1;').join('\n');
  const hint = ambiguousMatchHint(file, 'x = 1;', 20, { limit: 3 });
  assert.match(hint, /and 17 more/);
  assert.equal((hint.match(/line +\d+:/g) || []).length, 3);
});

test('relaxed-only ambiguity names the strategy and candidates', () => {
  const file = 'if (a) {\n  go();\n}\nif (b) {\n    go();\n}\n';
  // Exact text is absent; ignoring indentation it matches both blocks.
  assert.equal(relaxedReplace(file, 'go();\n', 'stop();\n'), null);
  const hint = ambiguousMatchHint(file, '\tgo();', 0);
  assert.match(hint, /after ignoring indentation it matches 2 places/);
  assert.match(hint, /line 2: go\(\);/);
  assert.match(hint, /line 5: go\(\);/);
});

test('no hint when the relaxed match is unique or absent', () => {
  assert.equal(ambiguousMatchHint('one\n  two\n', '\ttwo', 0), '');
  assert.equal(ambiguousMatchHint('one\ntwo\n', 'three', 0), '');
});

test('edit_file and multi_edit errors include occurrence lines', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-ambig-'));
  try {
    await writeFile(path.join(root, 'a.js'), 'let a = 2;\nfoo();\nlet b = 2;\n  done();\nbar();\n    done();\n');
    await assert.rejects(executeTool('edit_file', { path: 'a.js', old_string: ' = 2;', new_string: ' = 3;' }, { root }), (error) => {
      assert.match(error.message, /appears 2 times/);
      assert.match(error.message, /line 1: let a = 2;/);
      assert.match(error.message, /line 3: let b = 2;/);
      return true;
    });
    await assert.rejects(executeTool('edit_file', { path: 'a.js', old_string: 'done();', new_string: 'x' }, { root }), /appears 2 times[\s\S]*line 4[\s\S]*line 6/);
    await assert.rejects(executeTool('edit_file', { path: 'a.js', old_string: '\tdone();', new_string: '\tx();' }, { root }), /matches 2 places[\s\S]*line 4: done\(\);[\s\S]*line 6: done\(\);/);
    await assert.rejects(executeTool('multi_edit', { path: 'a.js', edits: [{ old_string: 'foo();', new_string: 'foo();\nlet c = 2;' }, { old_string: ' = 2;', new_string: ' = 4;' }] }, { root }), /Edit 2: old_string appears 3 times[\s\S]*line 3: let c = 2;[\s\S]*earlier edits/);
    assert.equal(await readFile(path.join(root, 'a.js'), 'utf8'), 'let a = 2;\nfoo();\nlet b = 2;\n  done();\nbar();\n    done();\n');
  } finally { await rm(root, { recursive: true, force: true }); }
});
