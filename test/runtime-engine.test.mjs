// Unit tests for the runtime engine pieces: the file list for the app's Files
// panel, turning a smart-connect result into a runtime config, and reading the
// runtime link a user pastes.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { listWorkspaceFiles } from '../src/workspace-files.mjs';
import { carryUndeliveredSteering, pendingSteering, sessionRestoreSnapshot, steerSession } from '../src/agent.mjs';
import { saveSession, loadSession } from '../src/sessions.mjs';
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


test('undelivered runtime steering is preserved as bounded session state', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-steering-session-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-steering-config-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir };
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });

  const session = {
    root,
    sessionId: 'abcdefab-cdef-1234-5678-abcdefabcdef',
    config: { protocol: 'openai-compatible', baseURL: 'https://example.invalid/v1', model: 'test-model' },
    messages: [
      { role: 'system', content: 'System instructions.' },
      ...Array.from({ length: 119 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', content: 'History ' + index }))
    ]
  };
  assert.equal(steerSession(session, 'Use tabs for indentation.'), true);
  assert.equal(steerSession(session, 'Keep the existing tests.'), true);
  assert.equal(pendingSteering(session), 2);

  const carried = carryUndeliveredSteering(session);
  assert.deepEqual(carried, ['Use tabs for indentation.', 'Keep the existing tests.']);
  assert.equal(pendingSteering(session), 0);
  assert.equal(session.messages.length, 120, 'the capped conversation is not mutated');
  assert.deepEqual(session.pendingSteering, carried);

  const saved = await saveSession(session, { env });
  const restored = await loadSession(root, saved.id, { env });
  assert.equal(restored.messages.length, 120);
  assert.equal(restored.messages[0].role, 'system');
  assert.deepEqual(restored.pendingSteering, carried);

  const invalid = [...Array.from({ length: 22 }, (_, i) => 'saved ' + i), 'x'.repeat(25_000), 42, '   '];
  const second = await saveSession({ ...session, pendingSteering: invalid }, { env });
  const bounded = await loadSession(root, second.id, { env });
  assert.equal(bounded.pendingSteering.length, 20);
  assert.deepEqual(bounded.pendingSteering.slice(0, -1), Array.from({ length: 19 }, (_, i) => 'saved ' + (i + 3)));
  assert.equal(bounded.pendingSteering.at(-1), 'x'.repeat(20_000));
});

test('!commands are split like a shell, and anything needing a real shell goes through sh -c', async () => {
  const { shellWords } = await import('../app/core/runtime.mjs');
  assert.deepEqual(shellWords('npm test -- --grep "adds two"'), ['npm', 'test', '--', '--grep', 'adds two']);
  assert.deepEqual(shellWords("git log --format='%h %s' -3"), ['git', 'log', '--format=%h %s', '-3']);
  assert.equal(shellWords('npm test | tail -5'), null);
  assert.equal(shellWords('echo $(whoami)'), null);
  assert.equal(shellWords('echo "$HOME"'), null);
  assert.equal(shellWords('ls *.mjs'), null);
  assert.equal(shellWords('FOO=bar node test.js'), null);
  assert.deepEqual(shellWords("echo '$HOME'"), ['echo', '$HOME']);
  assert.equal(shellWords('echo "open'), null);
});

test('!command runs through the runtime with approval, and its output goes with the next message', async () => {
  const calls = [];
  const events = [];
  let polled = 0;
  const client = {
    async api(url, { body } = {}) {
      calls.push([url, body]);
      if (url === '/api/terminal/command') return { jobId: 'j1' };
      if (url.startsWith('/api/jobs/j1?')) {
        polled++;
        return polled === 1
          ? { status: 'running', events: [{ id: 1, type: 'approval_required', data: { approvalId: 'a1', prompt: 'Run npm test?' } }] }
          : { status: 'completed', events: [{ id: 2, type: 'terminal_output', data: { exitCode: 1, approved: true, output: 'not ok 1 adds\n' } }] };
      }
      if (url === '/api/chat') return { jobId: 'j2', sessionId: 's' };
      if (url.startsWith('/api/jobs/j2?')) return { status: 'completed', events: [{ id: 1, type: 'completed', data: {} }] };
      return {};
    }
  };
  const asked = [];
  const agent = new RuntimeAgent({ client, pollMs: 1, onEvent: (e) => events.push(e), approve: async (req) => { asked.push(req.args.prompt); return true; } });
  await agent.runShell('npm test');
  assert.deepEqual(calls[0], ['/api/terminal/command', { command: 'npm', args: ['test'] }]);
  assert.deepEqual(asked, ['Run npm test?']);
  assert.ok(calls.some(([url, body]) => url === '/api/jobs/j1/approval' && body.approved === true));
  const result = events.find((e) => e.type === 'tool_result');
  assert.equal(result.ok, false);
  assert.match(result.content, /not ok 1 adds\n\[exit 1\]/);
  assert.equal(events[0].content, '!npm test');
  await agent.send('fix it');
  const chat = calls.find(([url]) => url === '/api/chat')[1];
  assert.match(chat.message, /untrusted terminal output/);
  assert.match(chat.message, /"output":"not ok 1 adds\\n"/);
  assert.ok(chat.message.endsWith('Your request:\nfix it'));
  assert.deepEqual(agent.pendingShell, []);
});


test('session rebuild snapshots retain bounded pending steering', () => {
  const snapshot = sessionRestoreSnapshot({
    sessionId: 'session-1',
    sessionName: 'My session',
    messages: [{ role: 'system', content: 'System.' }],
    todos: [],
    sharedTasks: null,
    pendingSteering: ['Use tabs.', 'Keep tests.']
  });
  assert.deepEqual(snapshot.pendingSteering, ['Use tabs.', 'Keep tests.']);
  assert.equal(snapshot.messages[0].role, 'system');
});


test('shell syntax uses run_shell and the guarded terminal endpoint', async () => {
  const calls = [];
  const approvals = [];
  let polls = 0;
  const client = {
    async api(url, { body } = {}) {
      calls.push([url, body]);
      if (url === '/api/terminal/command') return { jobId: 'shell-job' };
      if (url.startsWith('/api/jobs/shell-job?')) {
        polls++;
        return polls === 1
          ? { status: 'running', events: [{ id: 1, type: 'approval_required', data: { approvalId: 'approval-1', prompt: 'Run guarded shell command?' } }] }
          : { status: 'completed', events: [{ id: 2, type: 'terminal_output', data: { exitCode: 0, approved: true, output: '42\\n' } }] };
      }
      return {};
    }
  };
  const events = [];
  const agent = new RuntimeAgent({
    client, pollMs: 1, onEvent: (event) => events.push(event),
    approve: async (request) => { approvals.push(request.name); return true; }
  });
  await agent.runShell('node -e "console.log(6 * 7)" | cat');
  assert.deepEqual(calls[0], ['/api/terminal/command', { command: 'node -e "console.log(6 * 7)" | cat', args: [], shell: true }]);
  assert.deepEqual(approvals, ['run_shell']);
  assert.equal(events.find((event) => event.type === 'tool_result').name, 'run_shell');
});

test('pending terminal output is bounded and survives chat snapshots', () => {
  const agent = new RuntimeAgent({ client: { api: async () => ({}) } });
  agent.load({
    sessionId: 'saved-session',
    pendingShell: [
      { command: 'old command', code: 0, output: 'old output' },
      { command: 'second', code: 1, output: 'x'.repeat(1500) },
      { command: 'third', code: 0, output: 'third output' },
      { command: 'fourth', code: 2, output: 'fourth output' },
      null, 42
    ]
  });
  assert.equal(agent.sessionId, 'saved-session');
  assert.deepEqual(agent.pendingShell.map((item) => item.command), ['second', 'third', 'fourth']);
  assert.equal(agent.pendingShell[0].output.length, 1000);
  const restored = new RuntimeAgent({ client: { api: async () => ({}) } });
  restored.load(agent.snapshot());
  assert.deepEqual(restored.pendingShell, agent.pendingShell);
  restored.reset();
  assert.deepEqual(restored.pendingShell, []);
});

test('failed chat submission does not consume pending terminal output', async () => {
  const agent = new RuntimeAgent({
    client: { api: async (url) => { if (url === '/api/chat') throw new Error('offline'); return {}; } },
    onEvent: () => {}
  });
  agent.load({ pendingShell: [{ command: 'npm test', code: 1, output: 'one test failed' }] });
  await assert.rejects(agent.send('fix the failure'), /offline/);
  assert.equal(agent.pendingShell.length, 1);
});
