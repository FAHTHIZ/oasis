import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PermissionPolicy } from '../src/permissions.mjs';

function policyWithAllow(rule) {
  return new PermissionPolicy({ permissions: { allow: [rule] } });
}

test('a command-prefix rule allows the command it names', () => {
  const policy = policyWithAllow('Bash(npm test:*)');
  assert.equal(policy.evaluate('run_shell', { command: 'npm test' }).decision, 'allow');
  assert.equal(policy.evaluate('run_shell', { command: 'npm test -- --watch' }).decision, 'allow');
});

test('a command-prefix rule does not approve a chain containing an unapproved command', () => {
  const policy = policyWithAllow('Bash(npm test:*)');
  const commands = [
    'npm test && echo hi',
    'npm test | sh',
    'npm test; ls',
    'npm test $(whoami)',
    'npm test ' + String.fromCharCode(96) + 'id' + String.fromCharCode(96),
    'npm test <(whoami)'
  ];

  for (const command of commands) {
    assert.notEqual(
      policy.evaluate('run_shell', { command }).decision,
      'allow',
      command + ' must not be auto-approved'
    );
  }
});

test('operators inside quoted arguments are not treated as command separators', () => {
  const policy = policyWithAllow('Bash(npm test:*)');
  assert.equal(policy.evaluate('run_shell', { command: 'npm test "a && b"' }).decision, 'allow');
  assert.equal(policy.evaluate('run_shell', { command: "npm test 'a && b'" }).decision, 'allow');
});

test('even a broad allow rule fails closed on command substitution', () => {
  const policy = policyWithAllow('Bash(*)');
  assert.notEqual(
    policy.evaluate('run_shell', { command: 'npm test $(whoami)' }).decision,
    'allow'
  );
});

test('deny rules still match a denied command within a chain', () => {
  const policy = new PermissionPolicy({
    permissions: {
      allow: ['Bash(npm test:*)'],
      deny: ['Bash(ls:*)']
    }
  });
  assert.equal(policy.evaluate('run_shell', { command: 'npm test; ls' }).decision, 'deny');
});

test('read deny rules normalize workspace-relative and absolute paths case-insensitively', () => {
  const root = path.resolve('/workspace/oasis');
  const policy = new PermissionPolicy({
    permissions: { deny: ['Read(secrets/**)'] }
  }, { root });
  const paths = [
    'src/../secrets/key',
    './secrets/key',
    'SECRETS/key',
    path.join(root, 'secrets', 'key')
  ];

  for (const filePath of paths) {
    assert.equal(
      policy.evaluate('read_file', { path: filePath }).decision,
      'deny',
      filePath + ' must match Read(secrets/**)'
    );
  }
});
