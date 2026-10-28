import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const text = (messages) => messages.map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '')).join('\n');

test('/subtask forks the conversation into a background agent that reports back', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-subtask-'));
  const { config, requests } = await scriptedModel(t, [(payload) => {
    const all = text(payload.messages);
    if (all.includes('You are a fork of the conversation')) return { content: all.includes('SECRET-CODEWORD-42') ? 'FORK SAW CONTEXT' : 'FORK MISSED CONTEXT' };
    return { content: 'ok' };
  }]);
  const session = await createSession({ root, config, settings, env: { ...process.env, HOME: root } });
  t.after(() => closeSession(session));
  const notices = [];
  session.onAgentNotice = (notice) => notices.push(notice);
  await runAgentTurn(session, 'remember SECRET-CODEWORD-42');
  const before = session.messages.length;
  const result = await runBuiltinCommand('subtask', 'summarize what I asked', { root, session, env: process.env });
  assert.match(result.output, /Started agent_1/);
  assert.equal(session.messages.length, before);
  for (let i = 0; i < 100 && !notices.length; i++) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.match(String(notices[0]), /FORK SAW CONTEXT/);
  assert.ok(requests.length >= 2);
  const usage = await runBuiltinCommand('subtask', '', { root, session, env: process.env });
  assert.match(usage.output, /Usage/);
});
