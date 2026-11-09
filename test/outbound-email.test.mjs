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
