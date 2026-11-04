import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const home = mkdtempSync(path.join(os.tmpdir(), 'oasis-help-'));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: '1' } });

test('oasis --help fits on one screen and is grouped', () => {
  const out = run('--help').stdout;
  const lines = out.trimEnd().split('\n');
  assert.ok(lines.length <= 45, 'quick help should stay short, got ' + lines.length + ' lines');
  for (const heading of ['Usage:', 'Start', 'Set up and check', 'Extend', 'Safety', 'More']) assert.ok(lines.includes(heading), heading);
  assert.match(out, /oasis help all/);
  assert.match(out, /--safe-mode/);
  assert.equal(run('-h').stdout, out);
});

test('oasis help all and --help --all print the full reference', () => {
  const full = run('help', 'all').stdout;
  assert.ok(full.split('\n').length > 100);
  assert.match(full, /oasis mcp add --transport http\|sse NAME URL/);
  assert.equal(run('--help', '--all').stdout, full);
});

test('every command in the quick help exists in the full reference', () => {
  const quick = run('--help').stdout;
  const full = run('help', 'all').stdout;
  for (const cmd of ['oasis web', 'oasis setup', 'oasis doctor', 'oasis update', 'oasis init', 'oasis mcp list', 'oasis mcp add', 'oasis mcp remove', 'oasis skills', 'oasis plugins', 'oasis ide', 'oasis acp', 'oasis gateway', '--permission-mode', '--safe-mode', '--restricted', 'oasis -w', '--continue', '--resume']) {
    assert.ok(full.includes(cmd), cmd + ' missing from the full reference');
  }
  assert.ok(quick.includes('oasis -p'));
});
