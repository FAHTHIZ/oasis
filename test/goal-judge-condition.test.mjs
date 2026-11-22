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
  session.evidenceLedger = { seq: 1, epoch: 0, events: [{ seq: 1, kind: 'check', command: 'npm run build', exitCode: 0, passed: true, masked: false }] };
  const condition = 'Requirements: ' + 'the build passes; '.repeat(200) + 'and FINAL-REQUIREMENT: docs updated.';
  assert.ok(condition.length > 2000 && condition.length <= 4000);
  const verdict = await evaluateGoal(session, condition);
  assert.equal(verdict.met, false);
  assert.match(requests[0].messages.at(-1).content, /FINAL-REQUIREMENT: docs updated\./);
  closeSession(session);
});

test('a goal about tests is not met from the transcript alone, and no judge is asked', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-goal-judge-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [{ content: 'MET\nAll tests pass.' }, { content: 'MET\nAll tests pass.' }]);
  const session = await createSession({ root, config, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  session.messages.push({ role: 'user', content: 'fix it' }, { role: 'assistant', content: 'Done, npm test passes.' });
  const verdict = await evaluateGoal(session, 'npm test passes');
  assert.equal(verdict.met, false);
  assert.match(verdict.reason, /has not seen `npm test` run/);
  assert.equal(requests.length, 0);
  session.evidenceLedger.events.push({ seq: 1, kind: 'check', command: 'npm test', exitCode: 0, passed: true, masked: false });
  const second = await evaluateGoal(session, 'npm test passes');
  assert.equal(second.met, true, 'the record alone decides a condition that is one check passing');
  assert.equal(requests.length, 0);
  const third = await evaluateGoal(session, 'npm test passes and the fix is explained in CHANGELOG.md');
  assert.equal(third.met, true);
  assert.match(requests[0].messages.at(-1).content, /check `npm test`: exit 0/);
  closeSession(session);
});

test('with the goal verifier on, a MET from the judge needs the verify agent to pass it', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-goal-verify-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let verdictLine = 'FAIL handles empty input: `node cli.mjs ""` threw TypeError\nVERDICT: FAIL';
  const childPrompts = [];
  const { config } = await scriptedModel(t, [(payload) => {
    if (payload.messages[0].content.includes('SUBAGENT MODE')) { childPrompts.push(payload.messages.at(-1).content); return { content: verdictLine }; }
    return { content: 'MET\nThe CLI was written.' };
  }]);
  const env = { ...process.env, OASIS_AGENT_EXPERIENCE: '0', OASIS_NEURON_LEDGER: '0' };
  const session = await createSession({ root, env, config, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  t.after(() => closeSession(session));
  session.messages.push({ role: 'user', content: 'write the cli' }, { role: 'assistant', content: 'done' });
  const failed = await evaluateGoal(session, 'the CLI handles empty input', { env, verifier: true });
  assert.equal(failed.met, false);
  assert.match(failed.reason, /threw TypeError/);
  assert.match(childPrompts[0], /the CLI handles empty input/);
  verdictLine = 'PASS handles empty input: printed usage, exit 2\nVERDICT: PASS';
  assert.equal((await evaluateGoal(session, 'the CLI handles empty input', { env, verifier: true })).met, true);
  assert.equal((await evaluateGoal(session, 'the CLI handles empty input', { env })).met, true, 'off by default: the judge alone decides');
  assert.equal(childPrompts.length, 2);
});
