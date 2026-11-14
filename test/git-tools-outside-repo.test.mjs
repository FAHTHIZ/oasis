import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeTool } from '../src/tools.mjs';

// Regression (live benchmark, 2026-11-14): in a workspace that is not a Git
// repository, git_diff returned git's ~16 KB usage text, which the model then
// carried in every later request.
test('git_diff and git_status outside a Git repository answer in one short line', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-nogit-'));
  try {
    await writeFile(path.join(root, 'a.js'), 'export const a = 1;\n');
    for (const tool of ['git_diff', 'git_status']) {
      const result = await executeTool(tool, {}, { root });
      assert.notEqual(result.exitCode, 0, tool + ' should report failure');
      assert.equal(result.notGitRepository, true);
      assert.match(result.output, /not a Git repository/);
      assert.match(result.output, /read_file/);
      assert.ok(JSON.stringify(result).length < 1000, tool + ' result is ' + JSON.stringify(result).length + ' characters');
      assert.doesNotMatch(result.output, /usage: git/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('git_diff inside a repository (and a subfolder of one) still shows the change', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-git-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
    git('init', '-q');
    await writeFile(path.join(root, 'a.js'), 'export const a = 1;\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    await writeFile(path.join(root, 'a.js'), 'export const a = 2;\n');
    const result = await executeTool('git_diff', {}, { root });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /\+export const a = 2;/);
    const status = await executeTool('git_status', {}, { root });
    assert.equal(status.exitCode, 0);
    assert.match(status.stdout, /a\.js/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
