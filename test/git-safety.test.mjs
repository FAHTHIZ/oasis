import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { discardingGitCommand, snapshotWorkingTree } from '../src/git-safety.mjs';
import { executeTool } from '../src/tools.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

async function repo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-gitsafe-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q');
  await writeFile(path.join(root, 'a.txt'), 'committed\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'init');
  return root;
}

test('recognizes commands that discard local work', () => {
  for (const [command, args] of [['git', ['checkout', '.']], ['git', ['checkout', '--', 'a.txt']], ['git', ['restore', 'a.txt']], ['git', ['switch', '--discard-changes', 'main']], ['git', ['stash', 'drop']], ['git', ['stash', 'clear']], ['git', ['checkout', '-f', 'main']], ['git', ['-C', 'x', 'restore', '.']]]) {
    assert.ok(discardingGitCommand(command, args), command + ' ' + args.join(' '));
  }
  assert.ok(discardingGitCommand('npm test && git checkout . && echo ok'));
  for (const [command, args] of [['git', ['checkout', 'main']], ['git', ['checkout', '-b', 'feat']], ['git', ['restore', '--staged', 'a.txt']], ['git', ['status']], ['git', ['stash']], ['git', ['switch', 'main']]]) {
    assert.equal(discardingGitCommand(command, args), '', command + ' ' + args.join(' '));
  }
});

test('snapshot keeps tracked edits and untracked files without touching index or stash', async (t) => {
  const root = await repo(t);
  await writeFile(path.join(root, 'a.txt'), 'edited\n');
  await writeFile(path.join(root, 'new.txt'), 'untracked\n');
  const before = git(root, 'status', '--porcelain');
  const snap = await snapshotWorkingTree(root, 'git checkout .');
  assert.match(snap.ref, /^refs\/oasis\/safety\//);
  assert.equal(git(root, 'status', '--porcelain'), before, 'working tree and index unchanged');
  assert.equal(git(root, 'stash', 'list'), '');
  assert.equal(git(root, 'show', snap.ref + ':a.txt'), 'edited');
  assert.equal(git(root, 'show', snap.ref + ':new.txt'), 'untracked');
  assert.equal(await snapshotWorkingTree(await repo(t), 'git checkout .'), null, 'clean tree: nothing to save');
});

test('run_command git checkout . is recoverable from the safety snapshot', async (t) => {
  const root = await repo(t);
  await writeFile(path.join(root, 'a.txt'), 'precious work\n');
  const result = await executeTool('run_command', { command: 'git', args: ['checkout', '.'] }, { root, autoApprove: true, approval: async () => true, env: process.env });
  assert.equal(result.exitCode, 0);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'committed\n', 'the command really discarded the edit');
  assert.match(result.safetySnapshot, /Safety snapshot: uncommitted work was saved to refs\/oasis\/safety\//);
  const restore = result.safetySnapshot.match(/`(git restore [^`]+)`/)[1].split(' ').slice(1);
  git(root, ...restore);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'precious work\n');
});

test('denied commands leave no snapshot and OASIS_GIT_SAFETY=0 disables it', async (t) => {
  const root = await repo(t);
  await writeFile(path.join(root, 'a.txt'), 'edited\n');
  const denied = await executeTool('run_command', { command: 'git', args: ['checkout', '.'] }, { root, autoApprove: false, approval: async () => false, env: process.env });
  assert.equal(denied.approved, false);
  assert.equal(git(root, 'for-each-ref', 'refs/oasis/safety'), '');
  const off = await executeTool('run_command', { command: 'git', args: ['checkout', '.'] }, { root, autoApprove: true, approval: async () => true, env: { ...process.env, OASIS_GIT_SAFETY: '0' } });
  assert.equal(off.safetySnapshot, undefined);
});
