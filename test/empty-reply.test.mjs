import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

async function fixture(t, script) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-empty-'));
  await writeFile(path.join(root, 'a.txt'), 'A\n');
  const { config, requests } = await scriptedModel(t, script);
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions', env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: root } });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  return { session, requests };
}

test('an empty reply after a tool call is asked again instead of ending the turn as finished', async (t) => {
  const { session, requests } = await fixture(t, [toolCall('c1', 'read_file', { path: 'a.txt' }), { content: '' }, { content: 'The file says A.' }]);
  const result = await runAgentTurn(session, 'What does a.txt say?', {});
  assert.equal(result.text, 'The file says A.');
  assert.equal(requests.length, 3);
  assert.ok(!session.messages.some((m) => m.role === 'assistant' && m.content === ''), 'the empty reply is not kept in context');
});

test('a model that keeps replying empty ends with a clear notice, not a blank answer', async (t) => {
  const { session, requests } = await fixture(t, [toolCall('c1', 'read_file', { path: 'a.txt' }), { content: '' }]);
  const result = await runAgentTurn(session, 'What does a.txt say?', {});
  assert.equal(requests.length, 4, 'one tool step plus the empty reply and two retries');
  assert.match(result.text, /empty response/);
  assert.equal(result.emptyReply, true);
});

test('empty-reply re-asks are billed like any other request', async (t) => {
  const { session, requests } = await fixture(t, [toolCall('c1', 'read_file', { path: 'a.txt' }), { content: '' }, { content: 'The file says A.' }]);
  const usage = [];
  await runAgentTurn(session, 'What does a.txt say?', { onUsage: (event) => usage.push(event) });
  assert.equal(requests.length, 3);
  assert.equal(usage.filter((event) => event.step !== undefined || event.inputTokens !== undefined).length, 3, JSON.stringify(usage));
});

test('an empty reply stopped by the provider (content filter) is reported, not re-asked', async (t) => {
  const { session, requests } = await fixture(t, [toolCall('c1', 'read_file', { path: 'a.txt' }), (payload) => ({ content: '', finish_reason: 'content_filter' })]);
  const result = await runAgentTurn(session, 'What does a.txt say?', {});
  assert.equal(requests.length, 2);
  assert.match(result.text, /content_filter/);
  assert.equal(result.emptyReply, true);
});
