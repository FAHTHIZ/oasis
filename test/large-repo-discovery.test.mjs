import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { globWorkspaceFiles, searchWorkspaceFiles, walkFiles } from '../src/tools.mjs';

// Before the fix, glob_files and search_files stopped after the first 5,000 /
// 1,800 listed files, so a file sorted after them was reported as missing.
async function bigTree(git) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-big-'));
  for (let a = 0; a < 30; a++) {
    const dir = path.join(root, 'pkg' + String(a).padStart(2, '0'));
    await mkdir(dir, { recursive: true });
    await Promise.all(Array.from({ length: 200 }, (_, i) => writeFile(path.join(dir, 'f' + i + '.js'), 'export const v = ' + i + ';\n')));
  }
  await mkdir(path.join(root, 'zzz', 'deep'), { recursive: true });
  await writeFile(path.join(root, 'zzz', 'deep', 'needle_target.ts'), 'export const NEEDLE_UNIQUE = 1;\n');
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['add', '-A'], { cwd: root });
  }
  return root;
}

for (const git of [true, false]) {
  test('glob_files and search_files see past the first files of a 6,000-file tree (' + (git ? 'git' : 'plain walk') + ')', async () => {
    const root = await bigTree(git);
    const glob = await globWorkspaceFiles(root, '**/needle_target.ts');
    assert.deepEqual(glob.matches, ['zzz/deep/needle_target.ts']);
    assert.equal(glob.truncated, false);
    const found = await searchWorkspaceFiles(root, 'needle_unique');
    assert.deepEqual(found.matches.map((m) => [m.path, m.line]), [['zzz/deep/needle_target.ts', 1]]);
    const filtered = await walkFiles(root, { maxFiles: 3, filter: (rel) => rel.endsWith('.ts') });
    assert.deepEqual(filtered.map((f) => f.relative.split(path.sep).join('/')), ['zzz/deep/needle_target.ts']);
  });
}

test('glob_files truncation counts matches, not files listed', async () => {
  const root = await bigTree(true);
  const r = await globWorkspaceFiles(root, 'pkg29/*.js', 10);
  assert.equal(r.matches.length, 10);
  assert.equal(r.truncated, true);
  assert.ok(r.matches.every((m) => m.startsWith('pkg29/')));
});
