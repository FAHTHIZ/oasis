import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { unknownOptionMessage } from '../src/cli.mjs';

test('an unknown flag is reported with a did-you-mean hint instead of becoming the task', () => {
  assert.match(unknownOptionMessage('--modle'), /^Unknown option --modle\. Did you mean --model\?/);
  assert.match(unknownOptionMessage('--contnue=1'), /Unknown option --contnue\. Did you mean --continue\?/);
  assert.match(unknownOptionMessage('-z'), /^Unknown option -z\. Run oasis --help/);
  assert.doesNotMatch(unknownOptionMessage('--zzzzzzzzzzzz'), /Did you mean/);
  for (const prompt of ['fix the tests', '-1 is wrong', '- bullet', '--', '']) assert.equal(unknownOptionMessage(prompt), '', prompt);
});

test('oasis --bogus exits 1 with the message and does not start a task', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'oasis-unknown-opt-'));
  try {
    const result = spawnSync(process.execPath, [path.resolve('src/oasis.mjs'), '--bogus-flag', '-p', 'hi'], {
      cwd: home, encoding: 'utf8', timeout: 20000,
      env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_BASE_URL: 'http://127.0.0.1:9/v1', OASIS_ONE_SHOT: '1' }
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Unknown option --bogus-flag\./);
    assert.match(result.stderr, /put -- before it/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
