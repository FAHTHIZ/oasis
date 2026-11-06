import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { globWorkspaceFiles } from '../src/tools.mjs';
import { fileGlobMatcher } from '../src/glob.mjs';

test('glob_files supports braces, classes and literal bracket folders', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-glob-'));
  try {
    for (const file of ['a.js', 'b.ts', 'src/c.ts', 'src/d.mjs', 'app/[id]/page.tsx', 'app/x/page.tsx']) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), '');
    }
    const matches = async (pattern) => (await globWorkspaceFiles(root, pattern)).matches.sort();
    assert.deepEqual(await matches('**/*.{js,ts}'), ['a.js', 'b.ts', 'src/c.ts']);
    assert.deepEqual(await matches('src/*.[jt]s'), ['src/c.ts']);
    assert.deepEqual(await matches('app/[id]/page.tsx'), ['app/[id]/page.tsx']);
    assert.deepEqual(await matches('app/*/page.tsx'), ['app/[id]/page.tsx', 'app/x/page.tsx']);
    assert.match((await globWorkspaceFiles(root, '*.mjs')).hint, /src\/d\.mjs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('grep globs without a slash also match the file name', () => {
  const match = fileGlobMatcher('*.{md,txt}', { basename: true });
  assert.ok(match('docs/guide.md'));
  assert.ok(match('notes.txt'));
  assert.ok(!match('src/a.js'));
  assert.ok(fileGlobMatcher('.github/**')('.github/workflows/ci.yml'));
});
