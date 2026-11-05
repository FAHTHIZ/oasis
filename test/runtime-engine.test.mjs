// Unit tests for the runtime engine pieces: the file list for the app's Files
// panel, turning a smart-connect result into a runtime config, and reading the
// runtime link a user pastes.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { listWorkspaceFiles } from '../src/workspace-files.mjs';
import { carryUndeliveredSteering, pendingSteering, steerSession } from '../src/agent.mjs';
import { runtimeConfigFromConnection, connectFromPaste } from '../src/provider-connect.mjs';
import { tokenFromPaste, runtimeToken, RuntimeWorkspace, RuntimeAgent } from '../app/core/runtime.mjs';

test('workspace file list skips dependencies, secrets and symlinks, and is capped', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-files-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'));
  await mkdir(path.join(root, 'node_modules', 'x'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.js'), '1');
  await writeFile(path.join(root, 'README.md'), '#');
  await writeFile(path.join(root, '.env'), 'K=1');
  await writeFile(path.join(root, 'node_modules', 'x', 'i.js'), '1');
  try { await symlink(path.join(root, 'README.md'), path.join(root, 'link.md')); } catch { /* no symlinks here */ }
  const { files, truncated } = await listWorkspaceFiles(root, { isSecretPath: (p) => /(^|\/)\.env$/.test(p) });
  assert.deepEqual(files, ['README.md', 'src/a.js']);
  assert.equal(truncated, false);
  const capped = await listWorkspaceFiles(root, { limit: 1 });
  assert.equal(capped.files.length, 1);
  assert.equal(capped.truncated, true);
});

test('a smart-connect result becomes a runtime config with same-provider backups', () => {
  const config = runtimeConfigFromConnection({ connection: { protocol: 'openai', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-x', models: ['a/best', 'b/next', 'c/third', 'd/fourth', 'e/fifth'] }, model: 'a/best' });
  assert.deepEqual(config, { protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: 'a/best', apiKey: 'sk-or-x', fallbackModel: 'b/next,c/third,d/fourth' });
  assert.equal(runtimeConfigFromConnection({ connection: { protocol: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: 'k', models: ['m'] }, model: 'm' }).protocol, 'anthropic');
});

test('pasting something that is not a model connection gives a clear message', async () => {
  await assert.rejects(connectFromPaste('hello there'), /Paste an API key/);
  await assert.rejects(connectFromPaste('ghp_' + 'a'.repeat(36)), /GitHub token, not a model key/);
});

test('runtime links and tokens are recognised, model keys are not', () => {
  assert.equal(tokenFromPaste('http://127.0.0.1:4317/app/#token=abcdefghijklmnop0123456789'), 'abcdefghijklmnop0123456789');
  assert.equal(tokenFromPaste('a'.repeat(43)), 'a'.repeat(43));
  assert.equal(tokenFromPaste('sk-or-v1-' + 'a'.repeat(40)), '');
  assert.equal(tokenFromPaste('hello'), '');
});

test('the token is taken from the address, kept for the tab and removed from the URL', () => {
  const stored = new Map();
  let replaced = '';
  const win = {
    location: { hash: '#token=abcdefghijklmnop0123', pathname: '/app/', search: '' },
    sessionStorage: { setItem: (k, v) => stored.set(k, v), getItem: (k) => stored.get(k) || null },
    history: { replaceState: (_s, _t, url) => { replaced = url; } }
  };
  assert.equal(runtimeToken(win), 'abcdefghijklmnop0123');
  assert.equal(stored.get('oasis.web.token'), 'abcdefghijklmnop0123');
  assert.equal(replaced, '/app/');
  win.location.hash = '';
  assert.equal(runtimeToken(win), 'abcdefghijklmnop0123', 'reloads keep working');
});

test('runtime workspace maps git status and per-file diffs for the Changes tab', async () => {
  const client = { api: async (p) => p === '/api/workspace/diff'
    ? { files: [{ path: 'a.js', status: 'modified' }, { path: 'new.txt', status: 'untracked' }], diff: 'diff --git a/a.js b/a.js\nindex 1..2\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n' }
    : {} };
  const ws = new RuntimeWorkspace(client, { workspaceName: 'demo', workspacePath: '/tmp/demo' });
  assert.equal(ws.project.name, 'demo');
  assert.deepEqual(await ws.changes(), [{ path: 'a.js', status: 'modified' }, { path: 'new.txt', status: 'added' }]);
  assert.deepEqual(ws.fileDiff('a.js').map((l) => l.type + ':' + l.text), ['note:@@ -1 +1 @@', 'del:old', 'add:new', 'same:']);
});

test('a note typed while the runtime works goes to the running job', async () => {
  const calls = [];
  const events = [];
  const client = { api: async (path, options = {}) => { calls.push([path, options.body]); return { queued: true }; } };
  const agent = new RuntimeAgent({ client, onEvent: (e) => events.push(e) });
  assert.equal(await agent.steer('use tabs'), false, 'nothing is running yet');
  agent.busy = true; agent.jobId = '11111111-2222-3333-4444-555555555555';
  assert.equal(await agent.steer('  use tabs  '), true);
  assert.deepEqual(calls, [['/api/jobs/11111111-2222-3333-4444-555555555555/steer', { message: 'use tabs' }]]);
  assert.deepEqual(events, [{ type: 'user', content: 'use tabs', steer: true }]);
  client.api = async () => { throw new Error('That task is no longer running.'); };
  assert.equal(await agent.steer('late'), false);
});


test('undelivered runtime steering is moved into session history before persistence', () => {
  const session = { messages: [{ role: 'user', content: 'Build a counter.' }] };
  assert.equal(steerSession(session, 'Use tabs for indentation.'), true);
  assert.equal(steerSession(session, 'Keep the existing tests.'), true);
  assert.equal(pendingSteering(session), 2);

  const carried = carryUndeliveredSteering(session);
  assert.deepEqual(carried, ['Use tabs for indentation.', 'Keep the existing tests.']);
  assert.equal(pendingSteering(session), 0);
  assert.equal(session.messages.length, 2);
  assert.equal(session.messages[1].role, 'user');
  assert.match(session.messages[1].content, /1\. Use tabs for indentation\./);
  assert.match(session.messages[1].content, /2\. Keep the existing tests\./);
  assert.match(session.messages[1].content, /takes priority over earlier plans/);
  assert.deepEqual(carryUndeliveredSteering(session), [], 'carried notes are not duplicated');
});
