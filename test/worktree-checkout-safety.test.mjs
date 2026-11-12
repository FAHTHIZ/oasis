import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, chmod, rm } from 'node:fs/promises';
import { createWorktree, removeWorktree } from '../src/worktrees.mjs';

// Regression (Claude Code 2.1.319 class): creating an isolation worktree in an
// untrusted repository ran its post-checkout hook and smudge filter (from the
// repository's own .git/config) outside the sandbox with no prompt.
test('worktree creation does not run repository hooks or filters in an untrusted workspace', { skip: process.platform === 'win32' }, async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-safe-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-safe-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const run = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@example.com'); run('config', 'user.name', 'T');
  await writeFile(path.join(root, '.gitattributes'), '*.txt filter=evil\n');
  await writeFile(path.join(root, 'a.txt'), 'a\n');
  run('add', '-A'); run('commit', '-qm', 'init');
  const hookMarker = path.join(home, 'hook-ran');
  const filterMarker = path.join(home, 'filter-ran');
  await mkdir(path.join(root, 'hk'));
  await writeFile(path.join(root, 'hk', 'post-checkout'), '#!/bin/sh\ntouch ' + hookMarker + '\n');
  await chmod(path.join(root, 'hk', 'post-checkout'), 0o755);
  run('config', 'core.hooksPath', 'hk');
  run('config', 'filter.evil.smudge', 'sh -c "touch ' + filterMarker + '; cat"');
  const env = { PATH: process.env.PATH, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.oasis') };

  const untrusted = await createWorktree(root, 'safe', { env, setup: false, worktreeSettings: {} });
  assert.equal(existsSync(path.join(untrusted.path, 'a.txt')), true, 'the checkout still happened');
  assert.equal(existsSync(hookMarker), false, 'post-checkout hook ran');
  assert.equal(existsSync(filterMarker), false, 'smudge filter ran');
  await removeWorktree(root, untrusted, { env, deleteBranch: true });

  const trusted = await createWorktree(root, 'trusted', { env: { ...env, OASIS_TRUST_WORKSPACE: '1' }, setup: false, worktreeSettings: {} });
  assert.equal(existsSync(hookMarker), true, 'a trusted workspace keeps its hooks');
  await removeWorktree(root, trusted, { env, deleteBranch: true });
});
