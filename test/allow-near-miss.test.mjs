import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionPolicy } from '../src/permissions.mjs';

const policy = new PermissionPolicy({ permissions: { allow: ['run_shell(git:*)', 'run_shell(npm test)'] } }, { root: process.cwd() });

test('explains why an allowed program still asks', () => {
  assert.equal(policy.evaluate('run_shell', { command: 'git status' }).decision, 'allow');
  assert.equal(policy.allowNearMiss('run_shell', { command: 'git status' }), '');
  assert.match(policy.allowNearMiss('run_shell', { command: 'git log $(git rev-parse HEAD)' }), /command substitution/);
  assert.match(policy.allowNearMiss('run_shell', { command: 'git diff > out.txt' }), /a redirect/);
  assert.match(policy.allowNearMiss('run_shell', { command: 'git status && rm -rf build' }), /not "rm -rf build"/);
  assert.equal(policy.allowNearMiss('run_shell', { command: 'ls -la' }), '');
  assert.equal(policy.allowNearMiss('read_file', { path: 'a' }), '');
});
