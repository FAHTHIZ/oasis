import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, closeSession, askSideQuestion, evaluateGoal } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

async function longSession(t, contextWindow, script) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-side-window-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, script);
  const session = await createSession({ root, config: { ...config, contextWindow }, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  for (let i = 0; i < 100; i++) session.messages.push({ role: 'user', content: 'step ' + i + ' ' + 'u'.repeat(1500) }, { role: 'assistant', content: 'did ' + i + ' ' + 'a'.repeat(1500) });
  session.messages.push({ role: 'assistant', content: 'LATEST: all tests pass.' });
  t.after(() => closeSession(session));
  return { session, requests };
}

const sent = (request) => request.messages.map((m) => m.content).join('').length;

test('a side question fits an 8K-token window and keeps the newest turns', async (t) => {
  const { session, requests } = await longSession(t, 8192, [{ content: 'yes' }]);
  assert.equal(await askSideQuestion(session, 'did the tests pass?'), 'yes');
  assert.ok(sent(requests[0]) < 8192 * 4 * 0.7, 'sent ' + sent(requests[0]) + ' characters');
  assert.match(requests[0].messages.at(-1).content, /LATEST: all tests pass\.[\s\S]*did the tests pass\?/);
});

test('the goal check fits a 32K-token window', async (t) => {
  const { session, requests } = await longSession(t, 32768, [{ content: 'MET\nTests pass.' }]);
  assert.equal((await evaluateGoal(session, 'tests pass')).met, true);
  assert.ok(sent(requests[0]) < 32768 * 4 * 0.7, 'sent ' + sent(requests[0]) + ' characters');
});

test('a large window still gets the 150,000-character transcript', async (t) => {
  const { session, requests } = await longSession(t, 1_000_000, [{ content: 'ok' }]);
  await askSideQuestion(session, 'q');
  assert.ok(sent(requests[0]) > 140_000);
});
