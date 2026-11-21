import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sharedChatCommand } from '../src/gateway-commands.mjs';
import { createChatCore } from '../src/gateway-core.mjs';
import { createTelegramGateway } from '../src/gateway-telegram.mjs';

const ROOT = mkdtempSync(path.join(os.tmpdir(), 'oasis-chatcmd-'));

function fakeBuiltin(calls) {
  return async (name, argument, state) => {
    calls.push([name, argument]);
    if (name === 'rewind') { state.session.messages.splice(-2); return { output: 'Rewound 1 turn.' }; }
    if (name === 'model') { if (argument) state.session.config.model = argument; return { output: 'Model: ' + state.session.config.model }; }
    if (name === 'compact') return { output: argument === 'confirm' ? 'Conversation compacted.' : 'Preview' };
    return { output: name + ' output' };
  };
}

function fakeAgent(turns) {
  return {
    createSession: async () => ({ messages: [{ role: 'system', content: 's' }], config: { model: 'm1' }, permissions: { mode: 'default' } }),
    runAgentTurn: async (session, text) => { turns.push(text); session.messages.push({ role: 'user', content: text }, { role: 'assistant', content: 'ok' }); return { text: 'did ' + text.slice(0, 40) }; }
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('shared commands: retry, undo and compress need a session; unknown names fall through', async () => {
  const calls = [];
  const runBuiltin = fakeBuiltin(calls);
  const base = { root: ROOT, env: {}, runBuiltin, resolveSkill: async () => null, ensureState: async () => { throw new Error('no'); } };
  assert.deepEqual(await sharedChatCommand('retry', '', { ...base, state: null }), { text: 'Nothing to retry yet.' });
  assert.deepEqual(await sharedChatCommand('undo', '', { ...base, state: null }), { text: 'Nothing to undo yet.' });
  assert.equal(await sharedChatCommand('nonsense', '', { ...base, state: null }), null);
  const busy = { session: { messages: [] }, controller: {} };
  assert.match((await sharedChatCommand('model', 'x', { ...base, state: busy })).text, /Still working/);
  const state = { session: { messages: [{ role: 'system' }, { role: 'user', content: 'fix the bug' }, { role: 'assistant', content: 'done' }] }, controller: null };
  const retried = await sharedChatCommand('retry', '', { ...base, state });
  assert.equal(retried.prompt, 'fix the bug');
  assert.deepEqual(calls.at(-1), ['rewind', '1 chat']);
  assert.equal(state.session.messages.length, 1);
  calls.length = 0;
  assert.deepEqual(await sharedChatCommand('compress', '', { ...base, state }), { text: 'Conversation compacted.' });
  assert.deepEqual(calls, [['compact', ''], ['compact', 'confirm']]);
});

test('/<skill-name> in a chat runs the skill as the next turn', async () => {
  const skill = await sharedChatCommand('release-notes', 'v2', { root: ROOT, env: {}, state: null, ensureState: async () => ({}), resolveSkill: async (_root, text) => text.startsWith('/release-notes') ? { prompt: 'Use the skill. Request: v2', options: {} } : null });
  assert.deepEqual(skill, { prompt: 'Use the skill. Request: v2', text: '' });
});

test('chat gateways: /model, /retry, /usage and /reset', async () => {
  const sent = [];
  const turns = [];
  const calls = [];
  const deps = { agent: fakeAgent(turns), config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) }, slash: { runBuiltinCommand: fakeBuiltin(calls) }, commands: { resolveSkillCommand: async () => null } };
  const core = createChatCore({ platform: 'slack', root: ROOT, env: {}, deps, send: async (_key, text) => { sent.push(text); }, log: () => {} });
  await core.handleText('C1', '/model gpt-big');
  assert.equal(sent.at(-1), 'Model: gpt-big');
  await core.handleText('C1', 'write the tests');
  await settle();
  await core.handleText('C1', '/retry');
  await settle();
  assert.deepEqual(turns, ['write the tests', 'write the tests']);
  assert.match(sent.join('\n'), /Retrying: write the tests/);
  await core.handleText('C1', '!usage');
  assert.equal(sent.at(-1), 'usage output');
  await core.handleText('C1', '/reset');
  assert.equal(sent.at(-1), 'Started a fresh session.');
  await core.handleText('C1', '/help');
  assert.match(sent.at(-1), /\/retry runs the last request again/);

  const calls2 = [];
  const posted = [];
  const tturns = [];
  const tdeps = { ...deps, agent: fakeAgent(tturns), slash: { runBuiltinCommand: fakeBuiltin(calls2) } };
  const gateway = createTelegramGateway({ token: '123456:' + 'a'.repeat(30), allowedChats: new Set(['42']), root: ROOT, env: {}, deps: tdeps, fetchImpl: async (_url, init) => { posted.push(JSON.parse(init.body)); return new Response(JSON.stringify({ ok: true, result: true })); }, log: () => {} });
  await gateway.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '/insights 7' } });
  assert.deepEqual(calls2.at(-1), ['insights', '7']);
  assert.ok(posted.some((body) => body.text === 'insights output'));
});
