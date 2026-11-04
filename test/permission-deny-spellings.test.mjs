import test from 'node:test';
import assert from 'node:assert/strict';
import { PermissionPolicy, commandSpellings } from '../src/permissions.mjs';

const policy = () => new PermissionPolicy({ permissions: { deny: ['Bash(git push:*)', 'Bash(rm:*)', 'Bash(curl:*)'] } }, { root: '/tmp' });

test('deny rules catch alternate spellings of the same command', () => {
  const p = policy();
  const evasions = [
    'git  push origin', '"git" push', '\\git push', 'g""it push', "'git' push", 'git\tpush',
    'env git push', 'command git push', 'sudo git push', 'sudo -u root git push', 'nice -n 5 git push',
    'timeout 5 git push', 'FOO=1 git push', 'exec git push', 'time git push', 'eval git push',
    'bash -c "rm -rf x"', "sh -c 'git push'", 'bash -lc "cd x && git push"', '\\rm -rf x', '/bin/rm -rf x',
    'xargs rm < f', 'git -C . push', 'git --no-pager push', 'git -c core.x=1 push', 'curl  http://x', 'git push\\\n origin'
  ];
  for (const command of evasions) assert.equal(p.evaluate('run_shell', { command }).decision, 'deny', command);
});

test('deny spellings do not over-match unrelated commands', () => {
  const p = policy();
  for (const command of ['git status', 'git pull', 'echo git push', 'git log --grep push', 'ls rm', 'npm run rm', 'sudo -u root ls', 'bash script.sh']) {
    assert.notEqual(p.evaluate('run_shell', { command }).decision, 'deny', command);
  }
});

test('run_command with an env wrapper is denied too', () => {
  assert.equal(policy().evaluate('run_command', { command: '/usr/bin/env', args: ['git', 'push'] }).decision, 'deny');
});

test('allow rules are not broadened by wrapper stripping', () => {
  const p = new PermissionPolicy({ permissions: { allow: ['Bash(git status:*)'] } }, { root: '/tmp' });
  assert.equal(p.evaluate('run_shell', { command: 'git status' }).decision, 'allow');
  assert.notEqual(p.evaluate('run_shell', { command: 'sudo git status' }).decision, 'allow');
  assert.notEqual(p.evaluate('run_shell', { command: 'bash -c "git status; rm -rf /"' }).decision, 'allow');
});

test('commandSpellings exposes canonical forms', () => {
  const spellings = commandSpellings('sudo env A=1 /usr/bin/git -C repo push');
  assert.ok(spellings.has('git push'));
});
