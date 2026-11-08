import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
// A closed port: any network use would show up as a failure, not a hang.
const env = { ...process.env, OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:9/v1', OASIS_MODEL: 'x', OASIS_NO_UPDATE_CHECK: '1' };

test('oasis update --help prints usage and never checks or installs', () => {
  const result = spawnSync(process.execPath, [cli, 'update', '--help'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: oasis update \[--check\] \[--yes\]/);
  assert.doesNotMatch(result.stdout + result.stderr, /Installed:|Latest stable release/);
});

test('oasis update rejects unknown options before contacting GitHub', () => {
  const result = spawnSync(process.execPath, [cli, 'update', '--force'], { env, encoding: 'utf8', timeout: 30000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Unknown option for oasis update: --force/);
});

test('oasis setup --help prints usage instead of starting the wizard', () => {
  const result = spawnSync(process.execPath, [cli, 'setup', '--help'], { env, encoding: 'utf8', timeout: 30000, input: '' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage: oasis setup/);
  assert.doesNotMatch(result.stdout, /Choose \[1\/2\/3\]/);
});

test('oasis plugin --help lists the Claude Code marketplace commands', () => {
  const result = spawnSync(process.execPath, [cli, 'plugin', '--help'], { env, encoding: 'utf8', timeout: 30000 });
  assert.match(result.stdout, /oasis plugin marketplace add/);
  assert.match(result.stdout, /oasis plugin install NAME@MARKETPLACE/);
});
