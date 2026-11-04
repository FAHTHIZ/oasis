import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { multiEditFile } from '../src/power-tools.mjs';

test('multi_edit edits the editor buffer and updates it when an ACP client fs is present', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-multi-edit-fs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'a.js');
  await writeFile(file, 'const a = 1;\nconst b = 2;\n');
  const writes = [];
  const clientFs = {
    readTextFile: async () => 'const a = 1; // unsaved\nconst b = 2;\n',
    writeTextFile: async (target, content) => { writes.push({ target, content }); }
  };
  const result = await multiEditFile(root, { path: 'a.js', edits: [{ old_string: 'a = 1', new_string: 'a = 10' }, { old_string: 'b = 2', new_string: 'b = 20' }] }, { session: { clientFs } });
  assert.equal(result.changed, true);
  const expected = 'const a = 10; // unsaved\nconst b = 20;\n';
  assert.equal(await readFile(file, 'utf8'), expected);
  assert.deepEqual(writes, [{ target: file, content: expected }]);
});

test('multi_edit still works from disk without a client fs', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-multi-edit-disk-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'one two\n');
  await multiEditFile(root, { path: 'a.txt', edits: [{ old_string: 'two', new_string: 'three' }] }, {});
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one three\n');
});
