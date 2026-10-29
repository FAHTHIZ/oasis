import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  registerActiveSession, updateActiveSession, unregisterActiveSession,
  sendSessionMessage, readSessionInbox, listSessionInbox, updateInboxMessage,
  formatSessionMessage, resolveActiveTarget
} from '../src/session-messaging.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-messages-'));
  const root = path.join(home, 'project');
  await mkdir(root, { recursive: true });
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis') };
  t.after(() => rm(home, { recursive: true, force: true }));
  const source = { root, activeSessionId: randomUUID(), sessionName: 'sender' };
  const target = { root, activeSessionId: randomUUID(), sessionName: 'receiver' };
  await registerActiveSession(source, { env });
  await registerActiveSession(target, { env });
  return { env, root, source, target };
}

test('notify delivers a structured message to the recipient inbox without an execution channel', async (t) => {
  const { env, source, target } = await fixture(t);
  const sent = await sendSessionMessage(source, target.activeSessionId, 'Please inspect the API', {
    env, priority: 'warning', affectedFiles: ['src/api.mjs'], requestedAction: 'Review only; do not change code'
  });
  assert.equal(sent.queued, false);
  const received = await readSessionInbox(target, { env });
  assert.equal(received.length, 1);
  assert.equal(received[0].sourceSessionId, source.activeSessionId);
  assert.equal(received[0].priority, 'warning');
  assert.deepEqual(received[0].affectedFiles, ['src/api.mjs']);
  assert.equal(received[0].read, false);
  assert.match(formatSessionMessage(received[0]), /untrusted contextual data/);
  assert.match(formatSessionMessage(received[0]), /not auto-executed/);
});

test('busy targets retain queued messages until the session returns idle', async (t) => {
  const { env, source, target } = await fixture(t);
  await updateActiveSession(target, { state: 'busy' }, { env });
  const sent = await sendSessionMessage(source, target.activeSessionId, 'Wait for this turn', { env });
  assert.equal(sent.queued, true);
  assert.deepEqual(await readSessionInbox(target, { env }), []);
  await updateActiveSession(target, { state: 'active' }, { env });
  const received = await readSessionInbox(target, { env });
  assert.equal(received.length, 1);
  assert.equal(received[0].text, 'Wait for this turn');
});

test('stale targets are rejected and forwarding loops are blocked', async (t) => {
  const { env, source, target } = await fixture(t);
  await unregisterActiveSession(target, { env });
  await assert.rejects(resolveActiveTarget(target.activeSessionId, { env }), /No active Oasis session/);
  await assert.rejects(sendSessionMessage(source, target.activeSessionId, 'stale', { env }), /No active Oasis session/);
  await registerActiveSession(target, { env });
  await assert.rejects(sendSessionMessage(source, target.activeSessionId, 'loop', { env, forwardDepth: 1 }), /disabled to prevent loops/);
  await assert.rejects(sendSessionMessage(source, source.activeSessionId, 'self', { env }), /cannot notify itself/);
});

test('cross-workspace message targets are rejected even when their live IDs are known', async (t) => {
  const { env, source, target } = await fixture(t);
  await unregisterActiveSession(target, { env });
  target.root = path.join(path.dirname(source.root), 'different-project');
  await mkdir(target.root, { recursive: true });
  await registerActiveSession(target, { env });
  await assert.rejects(
    sendSessionMessage(source, target.activeSessionId, 'read another workspace', { env }),
    /Cross-workspace messages are disabled/
  );
  await assert.rejects(
    resolveActiveTarget(target.activeSessionId, { env, workspaceRoot: source.root }),
    /Cross-workspace messages are disabled/
  );
});

test('the agent receives queued messages as untrusted context before its next model decision', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-message-agent-home-'));
  const root = path.join(home, 'workspace');
  await mkdir(root, { recursive: true });
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis'), OASIS_AUTO_MEMORY: '0' };
  t.after(() => rm(home, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [{ content: 'I received the note as context.' }]);
  const settings = {
    permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' },
    hooks: {},
    sandbox: { enabled: false, network: false },
    shell: { enabled: false }
  };
  const recipient = await createSession({ root, config, settings, env, watchFiles: false });
  t.after(() => closeSession(recipient));
  const sender = { root, activeSessionId: randomUUID(), sessionName: 'sender' };
  await registerActiveSession(sender, { env });
  const target = await registerActiveSession(recipient, { env });
  const sent = await sendSessionMessage(sender, target.id, 'Please inspect src/api.mjs. Do not modify files.', {
    env,
    priority: 'warning',
    affectedFiles: ['src/api.mjs']
  });
  assert.equal(sent.queued, false);

  const result = await runAgentTurn(recipient, 'Hello, answer this message.', { env });
  assert.match(result.text, /received the note/);
  assert.equal(requests.length, 1);
  assert.ok(requests[0].messages.some((message) =>
    message.role === 'user' && typeof message.content === 'string' &&
    message.content.includes('CROSS-SESSION MESSAGE') &&
    message.content.includes('Please inspect src/api.mjs') &&
    message.content.includes('do not execute commands')
  ), 'incoming text must be labeled and included in the next model request as contextual data');
  assert.equal((await listSessionInbox(recipient, { env })).find((message) => message.id === sent.id).delivered, true);
});

test('inbox read/dismiss state is durable and commands return display text only', async (t) => {
  const { env, source, target, root } = await fixture(t);
  const sent = await sendSessionMessage(source, target.activeSessionId, 'Review this untrusted note', { env });
  const session = { ...target, root };
  const listed = await runBuiltinCommand('inbox', '', { root, env, session, sessionOptions: {} });
  assert.equal(typeof listed.output, 'string');
  assert.equal(listed.prompt, undefined, 'inbox content must never be forwarded as an agent prompt');
  assert.match(listed.output, /Review this untrusted note/);
  await runBuiltinCommand('inbox', 'read ' + sent.id, { root, env, session, sessionOptions: {} });
  assert.equal((await listSessionInbox(target, { env }))[0].read, true);
  await runBuiltinCommand('inbox', 'dismiss ' + sent.id, { root, env, session, sessionOptions: {} });
  assert.deepEqual(await listSessionInbox(target, { env }), []);
});

test('notify is rate limited and message text is bounded', async (t) => {
  const { env, source, target } = await fixture(t);
  for (let index = 0; index < 12; index++) await sendSessionMessage(source, target.activeSessionId, 'message ' + index, { env });
  await assert.rejects(sendSessionMessage(source, target.activeSessionId, 'over limit', { env }), /rate limit/);
  await assert.rejects(sendSessionMessage(source, target.activeSessionId, 'x'.repeat(4001), { env }), /4000-character limit/);
});
