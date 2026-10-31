import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { createWorktree, finishWorktree, inspectWorktree, mergeWorktree } from '../src/worktrees.mjs';
import { normalizeBranchPrefix, isWorktreeBranchName } from '../src/branch-names.mjs';

test('branch prefixes are validated and recognised', () => {
  for (const ok of ['oasis/', 'feature/', 'fh-', 'team/ai_', 'a.b/']) assert.equal(normalizeBranchPrefix(ok), ok);
  for (const bad of ['', '-x/', 'feature', 'a..b/', 'a//', '../', 'a/.b/', 'x@{/', 'has space/', 'x'.repeat(41) + '/']) assert.equal(normalizeBranchPrefix(bad), null, bad);
  assert.equal(isWorktreeBranchName('oasis/fix-tests-a1b2c3'), true);
  assert.equal(isWorktreeBranchName('feature/fix-tests-a1b2c3'), true);
  assert.equal(isWorktreeBranchName('fh-cloud-a1b2c3'), true);
  assert.equal(isWorktreeBranchName('main'), false);
  assert.equal(isWorktreeBranchName('../../etc'), false);
  assert.equal(isWorktreeBranchName('feature/a b'), false);
});

test('worktrees use the configured branch prefix and can still be inspected and merged', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-prefix-'));
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-prefix-cfg-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(config, { recursive: true, force: true })]));
  const run = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString();
  run('init', '-q', '-b', 'main'); run('config', 'user.email', 't@example.com'); run('config', 'user.name', 'T');
  await writeFile(path.join(root, 'app.txt'), 'v1\n');
  await mkdir(path.join(root, '.oasis'));
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ worktree: { branchPrefix: 'feature/' } }));
  run('add', '-A'); run('commit', '-qm', 'init');
  const env = { ...process.env, OASIS_CONFIG_DIR: config, OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_WORKTREE_BRANCH_PREFIX: '' };
  const wt = await createWorktree(root, 'Fix tests', { env });
  assert.match(wt.branch, /^feature\/fix-tests-[0-9a-f]{6}$/);
  await writeFile(path.join(wt.path, 'app.txt'), 'v2\n');
  const done = await finishWorktree(root, wt, { env });
  assert.equal(done.changed, true);
  const inspection = await inspectWorktree(root, wt.branch, { env });
  assert.equal(inspection.can_merge, true);
  await mergeWorktree(root, wt.branch, { env, expectedHead: inspection.head, expectedBranchHead: inspection.branch_head });
  assert.match(run('show', 'HEAD:app.txt'), /v2/);
  await assert.rejects(inspectWorktree(root, 'main', { env }), /OASIS-managed branch/);

  const fromEnv = await createWorktree(root, 'env run', { env: { ...env, OASIS_WORKTREE_BRANCH_PREFIX: 'fh-' } });
  assert.match(fromEnv.branch, /^fh-env-run-/);
  const invalid = await createWorktree(root, 'bad', { env: { ...env, OASIS_WORKTREE_BRANCH_PREFIX: '../x/' } });
  assert.match(invalid.branch, /^feature\/bad-/);
});
