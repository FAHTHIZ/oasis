import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, closeSession, evaluateGoal } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

test('the goal judge sees the whole condition, up to the 4,000-character goal limit', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-goal-judge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [{ content: 'NOT_MET\nThe docs were not updated.' }]);
  const session = await createSession({ root, config, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  session.messages.push({ role: 'user', content: 'work' }, { role: 'assistant', content: 'did some' });
  const condition = 'Requirements: ' + 'the build passes; '.repeat(200) + 'and FINAL-REQUIREMENT: docs updated.';
  assert.ok(condition.length > 2000 && condition.length <= 4000);
  const verdict = await evaluateGoal(session, condition);
  assert.equal(verdict.met, false);
  assert.match(requests[0].messages.at(-1).content, /FINAL-REQUIREMENT: docs updated\./);
  closeSession(session);
});
