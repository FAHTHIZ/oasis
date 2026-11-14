import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

test('the npm entry point runs the CLI with the compile cache on', () => {
  assert.equal(pkg.bin.oasis, './src/oasis.mjs');
  const cache = mkdtempSync(path.join(os.tmpdir(), 'oasis-ccache-'));
  try {
    const run = spawnSync(process.execPath, [path.join(ROOT, pkg.bin.oasis), '--version'], { encoding: 'utf8', env: { ...process.env, NODE_COMPILE_CACHE: cache } });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout.trim(), 'OASIS ' + pkg.version);
    assert.ok(readdirSync(cache).length > 0, 'compiled modules were cached');
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
});

test('the entry point passes arguments and exit codes through', () => {
  const bad = spawnSync(process.execPath, [path.join(ROOT, pkg.bin.oasis), 'uninstall', '--force'], { encoding: 'utf8', env: { ...process.env, OASIS_NO_COMPILE_CACHE: '1' } });
  assert.notEqual(bad.status, 0);
  assert.match(bad.stdout + bad.stderr, /Usage: oasis uninstall/);
});

test('bare --help, -h, help and help all answer from the help module with the full CLI output', () => {
  const run = (args, env = {}) => spawnSync(process.execPath, [path.join(ROOT, pkg.bin.oasis), ...args], { encoding: 'utf8', env: { ...process.env, OASIS_NO_COMPILE_CACHE: '1', NO_COLOR: '1', ...env } });
  for (const args of [['--help'], ['-h'], ['help'], ['help', 'all'], ['--help', 'all'], ['help', '--all']]) {
    const fast = run(args);
    const full = run(args, { OASIS_FULL_HELP_PATH: '1' });
    assert.equal(fast.status, 0, fast.stderr);
    assert.equal(full.status, 0, full.stderr);
    assert.equal(fast.stdout, full.stdout, 'oasis ' + args.join(' ') + ' prints the same help either way');
    assert.match(fast.stdout, /OASIS — a plain-English coding agent/);
  }
  // Anything more than a bare help request still goes through the full CLI.
  assert.match(run(['web', '--help']).stdout, /Usage: oasis web/);
});
