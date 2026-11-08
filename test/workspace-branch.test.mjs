import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { workspaceBranch } from '../src/git-tools.mjs';

test('workspaceBranch names the checked-out branch and is null outside a repository', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-branch-'));
  try {
    assert.equal(await workspaceBranch(dir), null);
    execFileSync('git', ['init', '-q', '-b', 'feature/header-pill'], { cwd: dir });
    assert.equal(await workspaceBranch(dir), 'feature/header-pill');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
