import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeCommand } from '../src/gateway-resume.mjs';
import { createChatCore } from '../src/gateway-core.mjs';
import { createTelegramGateway } from '../src/gateway-telegram.mjs';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const saved = [
  { id: 'aaaa1111-0000-4000-8000-000000000001', title: 'Fix the flaky login test', messages: 12, updatedAt: '2026-11-21T11:30:00Z' },
  { id: 'aaaa2222-0000-4000-8000-000000000002', title: 'Write release notes', messages: 4, updatedAt: '2026-11-19T09:00:00Z' },
  { id: 'bbbb3333-0000-4000-8000-000000000003', title: 'Archived', messages: 3, updatedAt: '2026-11-18T09:00:00Z', archived: true }
];
const store = (loaded = []) => ({
  listSessions: async () => saved,
  loadSession: async (_root, id) => { loaded.push(id); return { id, messages: Array.from({ length: 12 }, () => ({ role: 'user', content: 'x' })), updatedAt: saved[0].updatedAt }; },
  saveSession: async () => ({})
});

test('/resume lists, picks by number, last or prefix', async () => {
  const list = await resumeCommand([], { root: '/w', sessions: store(), now: () => NOW });
  assert.match(list.text, /1\. Fix the flaky login test — 12 messages, 30m ago \[aaaa1111\]/);
  assert.match(list.text, /2\. Write release notes — 4 messages, 2d ago/);
  assert.doesNotMatch(list.text, /Archived/);
  const loaded = [];
  assert.equal((await resumeCommand(['2'], { root: '/w', sessions: store(loaded) })).restore.id, saved[1].id);
  assert.equal((await resumeCommand(['last'], { root: '/w', sessions: store(loaded) })).restore.id, saved[0].id);
  assert.match((await resumeCommand(['aaaa'], { root: '/w', sessions: store() })).text, /More than one/);
  const hit = await resumeCommand(['aaaa2'], { root: '/w', sessions: store() });
  assert.match(hit.text, /oasis --resume aaaa2222-/);
  assert.match((await resumeCommand(['9'], { root: '/w', sessions: store() })).text, /No saved session matches 9/);
  assert.match((await resumeCommand([], { root: '/w', sessions: { listSessions: async () => [] } })).text, /No saved sessions/);
});

function fakeAgent(created) {
  return {
    createSession: async (options) => { created.push(options.restore); return { messages: options.restore ? options.restore.messages.slice() : [], sessionId: options.restore && options.restore.id, config: { model: 'm' }, permissions: { mode: 'default' } }; },
    runAgentTurn: async (session, text) => { session.messages.push({ role: 'user', content: text }); return { text: 'continued with ' + session.messages.length }; }
  };
}

test('a chat continues a saved session and keeps its ID', async () => {
  const created = [];
  const sent = [];
  const deps = { agent: fakeAgent(created), config: { loadConfig: async () => ({ configured: true }) }, sessions: store() };
  const core = createChatCore({ platform: 'slack', root: '/w', env: {}, deps, send: async (_key, text) => { sent.push(text); }, log: () => {} });
  await core.handleText('C1', '/resume 1');
  assert.match(sent.at(-1), /Resumed "Fix the flaky login test" \(12 messages\)/);
  assert.equal(created[0].id, saved[0].id);
  await core.handleText('C1', 'and now the logout test');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.match(sent.at(-1), /continued with 13/);
  assert.equal(core.chats.get('C1').session.sessionId, saved[0].id);
});

test('telegram supports /resume too', async () => {
  const created = [];
  const calls = [];
  const deps = { agent: fakeAgent(created), config: { loadConfig: async () => ({ configured: true }) }, sessions: store() };
  const gateway = createTelegramGateway({ token: '123456:' + 'a'.repeat(30), allowedChats: new Set(['42']), env: {}, deps, fetchImpl: async (url, init) => { calls.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: true })); }, log: () => {} });
  await gateway.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '/resume' } });
  assert.match(calls.at(-1).text, /Saved sessions in this workspace/);
  await gateway.handleUpdate({ update_id: 2, message: { chat: { id: 42 }, text: '/resume last' } });
  assert.match(calls.at(-1).text, /Resumed/);
  assert.equal(gateway.chats.get('42').session.sessionId, saved[0].id);
});
