// write_file and edit_file handle content past 256 KiB, and overwriting a
// large CRLF file keeps its line endings (it used to skip the check).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../src/tools.mjs';

test('large writes, appends and edits work', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-large-write-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const context = { root, autoApprove: true };
  const big = 'row,value\n'.repeat(60000);
  await executeTool('write_file', { path: 'data.csv', content: big }, context);
  assert.equal((await readFile(path.join(root, 'data.csv'), 'utf8')).length, big.length);
  await executeTool('read_file', { path: 'data.csv', offset: 1, limit: 5 }, context);
  await executeTool('write_file', { path: 'data.csv', content: 'tail\n', append: true }, context);
  assert.ok((await readFile(path.join(root, 'data.csv'), 'utf8')).endsWith('row,value\ntail\n'));

  await writeFile(path.join(root, 'win.txt'), 'line\r\n'.repeat(60000));
  await executeTool('read_file', { path: 'win.txt', offset: 1, limit: 5 }, context);
  await executeTool('write_file', { path: 'win.txt', content: 'new\n'.repeat(70000) }, context);
  const after = await readFile(path.join(root, 'win.txt'), 'utf8');
  assert.ok(after.startsWith('new\r\nnew\r\n'), 'CRLF kept on a large overwrite');

  const block = 'x'.repeat(300 * 1024);
  await executeTool('write_file', { path: 'gen.js', content: 'const A = "' + block + '";\n' }, context);
  await executeTool('read_file', { path: 'gen.js', offset: 1, limit: 1 }, context);
  await executeTool('edit_file', { path: 'gen.js', old_string: block, new_string: 'y'.repeat(300 * 1024) }, context);
  assert.match(await readFile(path.join(root, 'gen.js'), 'utf8'), /^const A = "y+";\n$/);
});

test('search_files finds a match inside a 3 MB source file', async (t) => {
  const { searchWorkspaceFiles } = await import('../src/tools.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-large-search-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'checker.ts'), 'const a = 1;\n'.repeat(250000) + 'function checkSourceElementWorker() {}\n');
  const found = await searchWorkspaceFiles(root, 'checkSourceElementWorker');
  assert.equal(found.matches.length, 1);
  assert.equal(found.matches[0].line, 250001);
});
