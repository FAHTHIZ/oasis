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

test('path deny rules follow symlinks to files and folders', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oasis-perm-'));
  fs.writeFileSync(path.join(root, '.env'), 'x');
  fs.mkdirSync(path.join(root, 'secrets'));
  fs.symlinkSync(path.join(root, '.env'), path.join(root, 'innocent.txt'));
  fs.symlinkSync(path.join(root, 'secrets'), path.join(root, 'docs'));
  const p = new PermissionPolicy({ permissions: { deny: ['Read(.env)', 'Edit(secrets/**)'], allow: ['Read(innocent.txt)'] } }, { root });
  assert.equal(p.evaluate('read_file', { path: 'innocent.txt' }).decision, 'deny');
  assert.equal(p.evaluate('write_file', { path: 'docs/new-file.txt' }).decision, 'deny');
  assert.notEqual(p.evaluate('read_file', { path: 'README.md' }).decision, 'deny');
  fs.rmSync(root, { recursive: true, force: true });
});

test('Read and Edit deny rules apply to shell commands touching those files', async () => {
  const { shellFileTargets } = await import('../src/permissions.mjs');
  const p = new PermissionPolicy({ permissions: { deny: ['Read(.env)', 'Edit(secrets/**)'] } }, { root: '/tmp/oasis-perm-shell' });
  for (const command of ['cat .env', 'cat ./.env | base64', 'grep KEY .env', 'head -1 /tmp/oasis-perm-shell/.env', 'sort < .env', 'sudo cat .env', 'bash -c "tail .env"']) {
    assert.equal(p.evaluate('run_shell', { command }).decision, 'deny', command);
  }
  for (const command of ['rm secrets/key', 'echo x > secrets/key', 'sed -i s/a/b/ secrets/key', 'cp a secrets/key', 'tee secrets/key < a', 'mv secrets/key /tmp/x']) {
    assert.equal(p.evaluate('run_shell', { command }).decision, 'deny', command);
  }
  for (const command of ['cat README.md', 'cat secrets/key', 'echo .env', 'ls', 'npm test 2>&1', 'echo hi > /dev/null']) {
    assert.notEqual(p.evaluate('run_shell', { command }).decision, 'deny', command);
  }
  assert.equal(p.evaluate('run_command', { command: 'cat', args: ['.env'] }).decision, 'deny');
  assert.deepEqual(shellFileTargets('cat a b > c 2>&1').writes, ['c']);
});
