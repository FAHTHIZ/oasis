import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createWorktree, finishWorktree, removeWorktree } from '../src/worktrees.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
}

test('isolated automatic commit blocks likely credentials and retains the branch for review', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'oasis-worktree-secret-scan-'));
  const root = path.join(temp, 'repo');
  const env = { ...process.env };
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'oasis-secret-test@example.invalid');
  git(root, 'config', 'user.name', 'OASIS secret scanner test');
  await writeFile(path.join(root, 'README.md'), '# Base\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'Initial fixture');
  const worktree = await createWorktree(root, 'secret scan', { env, requireClean: true });
  t.after(async () => {
    await removeWorktree(root, worktree, { env, deleteBranch: true }).catch(() => {});
    await rm(temp, { recursive: true, force: true });
  });
  const testOnlyCredential = 'ghp_' + 'A'.repeat(32);
  await writeFile(path.join(worktree.path, 'leak.txt'), 'example token=' + testOnlyCredential + '\n');
  await assert.rejects(
    finishWorktree(root, worktree, { env, blockSecrets: true }),
    /possible credentials were detected/i
  );
  assert.match(await readFile(path.join(worktree.path, 'leak.txt'), 'utf8'), /example token=/);
  assert.match(git(worktree.path, 'status', '--porcelain'), /leak\.txt/);
  assert.equal(git(root, 'status', '--porcelain'), '');
});
