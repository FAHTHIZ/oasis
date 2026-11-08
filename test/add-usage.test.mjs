import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const entry = new URL('../src/oasis.mjs', import.meta.url).pathname;

// `oasis add --help` used to fall through to the agent, which asked for a model provider.
test('oasis add without a source, or with --help, prints its usage instead of starting the agent', (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'oasis-add-usage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const env = { PATH: process.env.PATH, HOME: dir, OASIS_CONFIG_DIR: path.join(dir, 'cfg'), OASIS_NO_UPDATE_CHECK: '1' };
  for (const [args, status] of [[['add', '--help'], 0], [['add', '-h'], 0], [['add'], 1], [['add', '--project'], 1]]) {
    const run = spawnSync(process.execPath, [entry, ...args], { cwd: dir, env, encoding: 'utf8', input: '', timeout: 30000 });
    assert.match(run.stdout, /^Usage: oasis add </, args.join(' '));
    assert.doesNotMatch(run.stdout + run.stderr, /provider|API key/i, args.join(' '));
    assert.equal(run.status, status, args.join(' '));
  }
});
