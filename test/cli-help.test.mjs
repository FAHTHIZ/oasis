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

test('oasis doctor leads with a plain summary and a next step, details after', async () => {
  const { spawnSync } = await import('node:child_process');
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-doctor-order-'));
  const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
  const env = { ...process.env, HOME: dir, OASIS_CONFIG_DIR: path.join(dir, 'cfg'), OASIS_NO_UPDATE_CHECK: '1', NO_COLOR: '1' };
  for (const k of Object.keys(env)) if (/^OASIS_(BASE_URL|MODEL|PROVIDER|API_KEY)$/.test(k) || /_API_KEY$/.test(k)) delete env[k];
  const out = spawnSync(process.execPath, [cli, 'doctor'], { cwd: dir, env, encoding: 'utf8', timeout: 60000 }).stdout;
  assert.match(out, /^OASIS check\n/);
  assert.match(out, /Next step: run oasis setup to connect a model\./);
  assert.ok(out.indexOf('Next step:') < out.indexOf('Environment details'), out);
  assert.ok(out.indexOf('Environment details') < out.indexOf('OS / architecture'), out);
});
