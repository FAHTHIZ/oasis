import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startOasisWebServer } from '../src/web.mjs';
import { listSessions } from '../src/sessions.mjs';

test('POST /api/sessions/import copies a browser-only chat into the session store, once per key', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-import-'));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const token = 'test-runtime-token-0123456789';
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const post = (body, auth = true) => fetch(base + '/api/sessions/import', { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: 'Bearer ' + token } : {}) }, body: JSON.stringify(body) });
  const chat = {
    key: 'project-1:abc123', project: 'my-repo', title: 'Fix the login bug',
    messages: [
      { role: 'system', content: 'browser system prompt' },
      { role: 'user', content: 'Fix the login bug' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file text' },
      { role: 'assistant', content: 'Fixed in auth.js.' }
    ]
  };
  assert.equal((await post(chat, false)).status, 401);
  const first = await post(chat);
  assert.equal(first.status, 200);
  const { id, messages } = await first.json();
  assert.match(id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.equal(messages, 2, 'only text turns are kept');
  let listed = await listSessions(root, { env });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].title, 'my-repo: Fix the login bug');

  // The server list and session view (what other devices read) show it.
  const sessions = (await (await fetch(base + '/api/sessions', { headers: { authorization: 'Bearer ' + token } })).json()).sessions;
  assert.equal(sessions[0].id, id);
  const view = await (await fetch(base + '/api/sessions/' + id, { headers: { authorization: 'Bearer ' + token } })).json();
  assert.deepEqual(view.messages, [{ role: 'user', content: 'Fix the login bug' }, { role: 'assistant', content: 'Fixed in auth.js.' }]);

  // Sending the same chat again (with a new turn) updates the same session.
  const again = await post({ ...chat, messages: [...chat.messages, { role: 'user', content: 'Add a test' }, { role: 'assistant', content: 'Added.' }] });
  assert.equal((await again.json()).id, id);
  listed = await listSessions(root, { env });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].messages, 5);
  const stored = JSON.parse(await readFile(path.join((await import('../src/sessions.mjs')).getSessionDirectory(root, env), id + '.json'), 'utf8'));
  assert.ok(!stored.messages.some((item) => item.role === 'tool' || item.tool_calls), 'browser tool steps are not replayed into the server history');

  // A different key is a different session; bad input is refused.
  assert.notEqual((await (await post({ ...chat, key: 'project-1:other' })).json()).id, id);
  assert.equal((await post({ ...chat, key: '' })).status, 400);
  assert.equal((await post({ key: 'k', messages: [{ role: 'assistant', content: 'hi' }] })).status, 400);
});

test('the app copies changed browser-only chats once and skips server-backed ones', async () => {
  const { syncBrowserChats, chatTurns } = await import('../app/core/chat-sync.mjs');
  const values = new Map();
  const store = {
    listProjects: async () => [{ id: 'p1', name: 'repo-one' }, { id: 'p2', name: 'runtime' }],
    getValue: async (key) => values.get(key) ?? null,
    setValue: async (key, value) => { values.set(key, value); }
  };
  const chatKey = (projectId, id) => 'chat:' + projectId + (id === 'main' ? '' : ':' + id);
  const chatIndex = async (projectId) => values.get('chats:' + projectId) || { current: 'main', list: [] };
  values.set('chats:p1', { current: 'a', list: [{ id: 'a', title: 'Fix login', updatedAt: 100 }, { id: 'b', title: 'Empty', updatedAt: 90 }] });
  values.set('chat:p1:a', { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'Fix login' }, { role: 'assistant', content: 'Done.' }], display: [] });
  values.set('chat:p1:b', { messages: [{ role: 'assistant', content: 'hello' }], display: [] });
  values.set('chat:p1', { messages: [{ role: 'user', content: 'legacy first chat' }], display: [] });
  values.set('chats:p2', { current: 'x', list: [{ id: 'x', title: 'On the computer', updatedAt: 100 }] });
  values.set('chat:p2:x', { messages: { sessionId: 'abc' }, display: [] });
  const calls = [];
  const api = async (path, options) => { calls.push({ path, ...options }); return { id: 'srv-' + calls.length }; };

  assert.deepEqual(await syncBrowserChats({ store, api, chatIndex, chatKey }), { copied: 2, failed: 0 });
  assert.deepEqual(calls.map((call) => call.body.key), ['p1:a', 'p1:main']);
  assert.equal(calls[0].path, '/api/sessions/import');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { key: 'p1:a', project: 'repo-one', title: 'Fix login', messages: [{ role: 'user', content: 'Fix login' }, { role: 'assistant', content: 'Done.' }] });
  assert.equal(calls[1].body.title, 'legacy first chat');
  assert.deepEqual(values.get('chat:p1:a').serverCopy, { id: 'srv-1', updatedAt: 100 });

  // Nothing changed: nothing is sent. A newer save of chat a sends it again.
  calls.length = 0;
  assert.equal((await syncBrowserChats({ store, api, chatIndex, chatKey })).copied, 0);
  values.set('chats:p1', { current: 'a', list: [{ id: 'a', title: 'Fix login', updatedAt: 200 }] });
  values.set('chat:p1:a', { messages: [{ role: 'user', content: 'Fix login' }, { role: 'assistant', content: 'Done.' }, { role: 'user', content: 'And tests' }], display: [] });
  assert.equal((await syncBrowserChats({ store, api, chatIndex, chatKey })).copied, 1);
  assert.equal(calls[0].body.messages.length, 3);

  // A rejected key stops the run; the chat is tried again later.
  values.set('chats:p1', { current: 'a', list: [{ id: 'a', title: 'Fix login', updatedAt: 300 }] });
  const denied = async () => { throw Object.assign(new Error('no'), { status: 401 }); };
  assert.deepEqual(await syncBrowserChats({ store, api: denied, chatIndex, chatKey }), { copied: 0, failed: 1 });
  assert.equal(values.get('chat:p1:a').serverCopy.updatedAt, 200, 'still marked with the last copy that went through');
  assert.deepEqual(chatTurns([{ role: 'tool', content: 'x' }, { role: 'user', content: ' ' }, { role: 'user', content: 'ok' }]), [{ role: 'user', content: 'ok' }]);
});

test('the app runs the copy after connecting to the computer', async () => {
  const { readFileSync } = await import('node:fs');
  const app = readFileSync(new URL('../app/main.mjs', import.meta.url), 'utf8');
  const start = app.slice(app.indexOf('async function startRuntime('), app.indexOf('async function syncBrowserOnlyChats('));
  assert.match(start, /await restoreChat\(\);\n {2}void syncBrowserOnlyChats\(\);\n\}/);
  assert.match(app, /syncBrowserChats\(\{ store, api: \(path, options\) => RT\.client\.api\(path, options\), chatIndex, chatKey \}\)/);
});

test('a long browser chat is copied whole, not cut to its last 300 turns', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-import-long-'));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const token = 'test-runtime-token-0123456789';
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const { syncBrowserChats } = await import('../app/core/chat-sync.mjs');
  const messages = [];
  for (let i = 0; i < 400; i++) messages.push({ role: i % 2 ? 'assistant' : 'user', content: 'turn ' + i });
  const values = new Map([['chats:p', { current: 'a', list: [{ id: 'a', title: 'Long', updatedAt: 1 }] }], ['chat:p:a', { messages, display: [] }]]);
  const store = { listProjects: async () => [{ id: 'p', name: 'repo' }], getValue: async (key) => values.get(key) ?? null, setValue: async (key, value) => { values.set(key, value); } };
  const api = async (url, options) => {
    const response = await fetch('http://127.0.0.1:' + app.port + url, { method: options.method, headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token }, body: JSON.stringify(options.body) });
    return response.json();
  };
  assert.equal((await syncBrowserChats({ store, api, chatIndex: async (id) => values.get('chats:' + id), chatKey: (p, id) => 'chat:' + p + ':' + id })).copied, 1);
  const listed = await listSessions(root, { env });
  assert.equal(listed[0].messages, 401);
});
