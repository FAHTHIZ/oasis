import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

// Regression: `oasis "fix the bug"` with no provider printed the setup hint
// but exited 0, so scripts treated a run that never happened as a success.
test('a one-shot prompt with no provider configured exits non-zero', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'oasis-unconf-'));
  try {
    const env = { PATH: process.env.PATH, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_ONE_SHOT: '1' };
    const run = spawnSync(process.execPath, [CLI, 'fix the bug'], { cwd: home, env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.match(run.stdout + run.stderr, /needs a model provider/);
    assert.equal(run.status, 1);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('-C with a missing folder names the folder instead of a raw ENOENT', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'oasis-unconf-'));
  try {
    const missing = path.join(home, 'no-such-dir');
    const env = { PATH: process.env.PATH, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_ONE_SHOT: '1' };
    const run = spawnSync(process.execPath, [CLI, '-C', missing, '-p', 'hi'], { cwd: home, env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /workspace folder does not exist .*no-such-dir/);
    assert.doesNotMatch(run.stderr, /ENOENT/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
