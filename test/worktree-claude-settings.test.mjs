import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, lstat, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createWorktree, finishWorktree, removeWorktree } from '../src/worktrees.mjs';
import { loadSettings } from '../src/settings.mjs';

const gitEnv = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const git = (cwd, args) => execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();

async function repo() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-wtset-'));
  const root = path.join(base, 'repo');
  await mkdir(path.join(root, 'packages', 'app'), { recursive: true });
  await mkdir(path.join(root, 'shared'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'dep'), { recursive: true });
  await writeFile(path.join(root, 'packages', 'app', 'index.js'), 'app\n');
  await writeFile(path.join(root, 'shared', 'util.js'), 'util\n');
  await writeFile(path.join(root, 'README'), 'top\n');
  await writeFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'dep\n');
  await writeFile(path.join(root, '.gitignore'), 'node_modules/\n');
  git(base, ['init', '-q', '-b', 'main', root]);
  git(root, ['add', '-A']);
  git(root, ['commit', '-qm', 'init']);
  const env = { ...gitEnv, OASIS_CONFIG_DIR: path.join(base, 'cfg'), HOME: path.join(base, 'home'), OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: '' };
  return { base, root, env };
}

test('worktree.sparsePaths checks out only the listed folders plus root files', async () => {
  const { root, env } = await repo();
  const wt = await createWorktree(root, 'sparse', { env, setup: false, worktreeSettings: { sparsePaths: ['packages/app', '../escape'] } });
  assert.deepEqual(wt.sparsePaths, ['packages/app']);
  assert.equal(existsSync(path.join(wt.path, 'packages', 'app', 'index.js')), true);
  assert.equal(existsSync(path.join(wt.path, 'README')), true);
  assert.equal(existsSync(path.join(wt.path, 'shared')), false);
  assert.equal(git(wt.path, ['status', '--porcelain']), '');
  await removeWorktree(root, wt, { env, deleteBranch: true });
});

test('worktree.symlinkDirectories links shared folders, which are never committed', async () => {
  const { root, env } = await repo();
  const wt = await createWorktree(root, 'links', { env, setup: false, worktreeSettings: { symlinkDirectories: ['node_modules', 'missing', '../outside', 'shared'] } });
  assert.deepEqual(wt.symlinks, ['node_modules'], 'tracked or missing folders are left alone');
  assert.equal((await lstat(path.join(wt.path, 'node_modules'))).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(wt.path, 'node_modules', 'dep', 'index.js'), 'utf8'), 'dep\n');
  await writeFile(path.join(wt.path, 'shared', 'util.js'), 'changed\n');
  const done = await finishWorktree(root, wt, { env, message: 'edit' });
  assert.equal(done.changed, true);
  assert.deepEqual(done.files, ['shared/util.js']);
  assert.equal(await readFile(path.join(root, 'node_modules', 'dep', 'index.js'), 'utf8'), 'dep\n', 'the shared folder survives');
});

test('worktree.baseRef "fresh" branches from origin\'s default branch; the default stays HEAD', async () => {
  const { base, root, env } = await repo();
  const origin = path.join(base, 'origin.git');
  git(base, ['clone', '-q', '--bare', root, origin]);
  git(root, ['remote', 'add', 'origin', origin]);
  git(root, ['fetch', '-q', 'origin']);
  git(root, ['remote', 'set-head', 'origin', 'main']);
  const remoteSha = git(root, ['rev-parse', 'origin/main']);
  await writeFile(path.join(root, 'local.txt'), 'unpushed\n');
  git(root, ['add', 'local.txt']);
  git(root, ['commit', '-qm', 'local']);
  const fresh = await createWorktree(root, 'fresh', { env, setup: false, worktreeSettings: { baseRef: 'fresh' } });
  assert.equal(fresh.base, remoteSha);
  assert.equal(fresh.baseRef, 'origin/main');
  const head = await createWorktree(root, 'head', { env, setup: false, worktreeSettings: {} });
  assert.equal(head.base, git(root, ['rev-parse', 'HEAD']));
  await removeWorktree(root, fresh, { env, deleteBranch: true });
  await removeWorktree(root, head, { env, deleteBranch: true });
});

test('worktree keys are read from settings files, an untrusted repository too', async () => {
  const { root, env } = await repo();
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ worktree: { symlinkDirectories: ['node_modules'], sparsePaths: ['packages/app'], baseRef: 'fresh' } }));
  const loaded = await loadSettings(root, { env });
  assert.deepEqual(loaded.worktree.symlinkDirectories, ['node_modules']);
  assert.deepEqual(loaded.worktree.sparsePaths, ['packages/app']);
  assert.equal(loaded.worktree.baseRef, 'fresh');
  const wt = await createWorktree(root, 'from-settings', { env, setup: false });
  assert.deepEqual(wt.symlinks, ['node_modules']);
  assert.deepEqual(wt.sparsePaths, ['packages/app']);
  await removeWorktree(root, wt, { env, deleteBranch: true });
});
