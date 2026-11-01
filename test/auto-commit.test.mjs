import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, unlink, mkdir } from 'node:fs/promises';
import { autoCommitEnabled, autoCommitTurn, commitSubject, describeAutoCommit } from '../src/auto-commit.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();

async function repo(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-autocommit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.name', 'T'); git(root, 'config', 'user.email', 't@example.com'); git(root, 'config', 'commit.gpgsign', 'false');
  await writeFile(path.join(root, 'a.js'), 'a\n'); await writeFile(path.join(root, 'b.js'), 'b\n'); await writeFile(path.join(root, '.gitignore'), 'dist/\n');
  git(root, 'add', '-A'); git(root, 'commit', '-qm', 'init');
  return root;
}

test('commits exactly the files the turn changed and leaves other work alone', async (t) => {
  const root = await repo(t);
  await writeFile(path.join(root, 'a.js'), 'a2\n');          // changed by OASIS
  await writeFile(path.join(root, 'new.js'), 'n\n');         // created by OASIS
  await unlink(path.join(root, 'b.js'));                     // deleted by OASIS
  await writeFile(path.join(root, 'mine.txt'), 'user\n');    // user's own untracked file
  await writeFile(path.join(root, 'staged.txt'), 's\n'); git(root, 'add', 'staged.txt'); // user's staged work
  const result = await autoCommitTurn({ root, paths: ['a.js', 'new.js', 'b.js'], prompt: 'Fix the parser\nand more' });
  assert.equal(result.subject, 'oasis: Fix the parser');
  assert.deepEqual(result.files.sort(), ['a.js', 'b.js', 'new.js']);
  assert.deepEqual(git(root, 'show', '--name-status', '--format=', 'HEAD').split('\n').sort(), ['A\tnew.js', 'D\tb.js', 'M\ta.js']);
  assert.match(git(root, 'log', '-1', '--format=%B'), /Files changed by OASIS in this turn:\n- a\.js/);
  const status = git(root, 'status', '--porcelain');
  assert.match(status, /^A  staged\.txt$/m);
  assert.match(status, /^\?\? mine\.txt$/m);
  assert.match(describeAutoCommit(result), /^Committed [0-9a-f]{7,} oasis: Fix the parser \(3 files\)\. Undo with git reset --soft HEAD~1\.$/);
});

test('skips ignored files, unchanged files, non-repositories and merges', async (t) => {
  const root = await repo(t);
  await mkdir(path.join(root, 'dist')); await writeFile(path.join(root, 'dist', 'out.js'), 'x\n');
  assert.equal((await autoCommitTurn({ root, paths: ['dist/out.js'], prompt: 'build' })).skipped, 'the changed files are ignored by Git');
  assert.equal((await autoCommitTurn({ root, paths: ['a.js'], prompt: 'noop' })).skipped, 'the files match the last commit');
  const plain = await mkdtemp(path.join(os.tmpdir(), 'oasis-autocommit-plain-'));
  t.after(() => rm(plain, { recursive: true, force: true }));
  assert.equal((await autoCommitTurn({ root: plain, paths: ['x'], prompt: 'x' })).skipped, 'not a Git repository');
  await writeFile(path.join(root, '.git', 'MERGE_HEAD'), git(root, 'rev-parse', 'HEAD') + '\n');
  await writeFile(path.join(root, 'a.js'), 'changed\n');
  assert.match((await autoCommitTurn({ root, paths: ['a.js'], prompt: 'x' })).skipped, /merge/);
});

test('a failing pre-commit hook is reported and the files stay staged', async (t) => {
  const root = await repo(t);
  await writeFile(path.join(root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho "lint failed" >&2\nexit 1\n', { mode: 0o755 });
  await writeFile(path.join(root, 'a.js'), 'bad\n');
  const result = await autoCommitTurn({ root, paths: ['a.js'], prompt: 'x' });
  assert.match(result.error, /git commit failed \(the files are staged\): lint failed/);
  assert.match(git(root, 'status', '--porcelain'), /^M  a\.js$/m);
});

test('subjects are one short line', () => {
  assert.equal(commitSubject(''), 'oasis: changes');
  assert.equal(commitSubject('/fix the flaky test'), 'oasis: fix the flaky test');
  const long = commitSubject('Refactor the configuration loader so that every provider shares one validation path and error format');
  assert.ok(long.length <= 72, long);
  assert.match(long, /…$/);
});

test('enabled by env, settings or /auto-commit; the session toggle wins', async () => {
  assert.equal(autoCommitEnabled({}, {}), false);
  assert.equal(autoCommitEnabled({}, { OASIS_AUTO_COMMIT: '1' }), true);
  assert.equal(autoCommitEnabled({ settings: { autoCommit: true } }, {}), true);
  assert.equal(autoCommitEnabled({ settings: { autoCommit: true } }, { OASIS_AUTO_COMMIT: 'off' }), false);
  const session = { settings: {} };
  const on = await runBuiltinCommand('auto-commit', 'on', { session, env: {} });
  assert.match(on.output, /Auto-commit on/);
  assert.equal(autoCommitEnabled(session, { OASIS_AUTO_COMMIT: '0' }), true);
  await runBuiltinCommand('auto-commit', '', { session, env: {} });
  assert.equal(session.autoCommit, false);
});
