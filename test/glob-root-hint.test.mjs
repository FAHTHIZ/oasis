import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { globWorkspaceFiles } from '../src/tools.mjs';

// From a live gpt-oss-20b run: glob "*.mjs" found nothing at the root and the
// model concluded the project had no modules, though src/ was full of them.
test('a root-only glob with no matches points at matching files in subfolders', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-glob-hint-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.mjs'), '');
  await writeFile(path.join(root, 'src', 'b.mjs'), '');
  await writeFile(path.join(root, 'README.md'), '');
  const miss = await globWorkspaceFiles(root, '*.mjs');
  assert.deepEqual(miss.matches, []);
  assert.match(miss.hint, /2 files in subfolders match "\*\*\/\*\.mjs"/);
  assert.match(miss.hint, /src\/a\.mjs/);
  const hit = await globWorkspaceFiles(root, '*.md');
  assert.deepEqual(hit.matches, ['README.md']);
  assert.equal(hit.hint, undefined);
  const none = await globWorkspaceFiles(root, '*.py');
  assert.equal(none.hint, undefined);
  const scoped = await globWorkspaceFiles(root, 'lib/*.mjs');
  assert.equal(scoped.hint, undefined);
});

test('the app glob tool already matches a slash-free pattern in any folder', async () => {
  const { executeTool } = await import('../app/core/tools.mjs');
  const ctx = { workspace: { paths: async () => ['src/a.ts', 'src/b.ts', 'README.md'] } };
  assert.equal(await executeTool('glob_files', { pattern: '*.ts' }, ctx), 'src/a.ts\nsrc/b.ts');
});
