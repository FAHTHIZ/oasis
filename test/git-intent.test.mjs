import test from 'node:test';
import assert from 'node:assert/strict';
import { unrequestedGitWrite } from '../src/git-intent.mjs';

test('commits, pushes, remotes and global config need to be asked for', () => {
  const task = 'Create src/lib.mjs exporting clampInteger(...)';
  assert.match(unrequestedGitWrite(task, 'git_commit', { message: 'x' }), /did not ask you to commit/);
  assert.match(unrequestedGitWrite(task, 'git_push', {}), /push/);
  assert.match(unrequestedGitWrite(task, 'run_command', { command: 'git', args: ['push', 'origin', 'master'] }), /push/);
  assert.match(unrequestedGitWrite(task, 'run_command', { command: 'git', args: ['config', '--global', 'user.email', 'a@b'] }), /global git config/);
  assert.match(unrequestedGitWrite(task, 'run_command', { command: 'git', args: ['remote', 'add', 'origin', 'https://x'] }), /remotes/);
  assert.match(unrequestedGitWrite(task, 'run_command', { command: 'bash -c "git add . && git commit -m wip"' }), /commit/);
  assert.match(unrequestedGitWrite(task, 'run_command', { command: 'gh', args: ['pr', 'create'] }), /pull request/);
});

test('ordinary git use and requested writes are allowed', () => {
  const task = 'fix the parser';
  assert.equal(unrequestedGitWrite(task, 'run_command', { command: 'git', args: ['status'] }), null);
  assert.equal(unrequestedGitWrite(task, 'run_command', { command: 'git', args: ['add', 'a.mjs'] }), null);
  assert.equal(unrequestedGitWrite(task, 'run_command', { command: 'git', args: ['config', 'user.email'] }), null);
  assert.equal(unrequestedGitWrite(task, 'git_diff', {}), null);
  assert.equal(unrequestedGitWrite('fix the parser and commit it', 'git_commit', {}), null);
  assert.equal(unrequestedGitWrite('push my changes', 'run_command', { command: 'git', args: ['push'] }), null);
  assert.equal(unrequestedGitWrite('open a PR for this', 'create_pull_request', {}), null);
  assert.equal(unrequestedGitWrite(task, 'git_push', {}, { settings: { allowUnrequestedGitWrites: true } }), null);
  assert.equal(unrequestedGitWrite(task, 'git_push', {}, { env: { OASIS_ALLOW_UNREQUESTED_GIT_WRITES: '1' } }), null);
});

test('eval agent environment drops credentials and blocks git pushes', async () => {
  const { evalAgentEnvironment } = await import('../src/eval.mjs');
  const env = evalAgentEnvironment({ PATH: '/bin', GH_TOKEN: 'x', GH_ENTERPRISE_TOKEN: 'y', OPENAI_API_KEY: 'z', HOME: '/home/u' });
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.PATH, '/bin');
  assert.equal(env.GIT_TERMINAL_PROMPT, '0');
  const keys = Object.keys(env).filter((key) => key.startsWith('GIT_CONFIG_KEY_')).map((key) => env[key]);
  assert.ok(keys.includes('url.file:///oasis-eval-push-blocked/.pushInsteadOf'));
  assert.equal(Number(env.GIT_CONFIG_COUNT), keys.length);
});
