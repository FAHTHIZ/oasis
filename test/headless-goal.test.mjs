import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { runHeadless } from '../src/headless.mjs';
import { parseGoalVerdict } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

test('goal verdicts survive markdown and never read NOT_MET as met', () => {
  assert.equal(parseGoalVerdict('MET\nall green').met, true);
  assert.equal(parseGoalVerdict('**MET**\nall green').met, true);
  assert.equal(parseGoalVerdict('Verdict: MET').met, true);
  assert.equal(parseGoalVerdict('NOT_MET\nno test ran').met, false);
  assert.equal(parseGoalVerdict('`NOT MET` yet').met, false);
  assert.equal(parseGoalVerdict('').met, false);
  assert.equal(parseGoalVerdict('MET\nall green').reason, 'all green');
});

test('-p --goal keeps working until the check says the goal is met', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [
    { content: 'I looked at it.' },
    { content: 'NOT_MET\nNothing was changed yet.' },
    { content: 'Now it is done.' },
    { content: 'MET\nThe reply shows the work.' }
  ]);
  let out = '';
  const { exitCode, summary } = await runHeadless({ prompt: 'Goal: finish', goal: 'finish', root, config, outputFormat: 'stream-json', sessionOptions: { settings }, write: (text) => { out += text; } });
  const events = out.trim().split('\n').map((line) => JSON.parse(line));
  const checks = events.filter((event) => event.subtype === 'goal_check');
  assert.deepEqual(checks.map((event) => event.met), [false, true]);
  assert.equal(exitCode, 0);
  assert.equal(summary.subtype, 'success');
  assert.equal(summary.goal.met, true);
  assert.equal(summary.goal.turns, 2);
  assert.equal(summary.result, 'Now it is done.');
});

test('a goal that is never met ends as error_goal_not_met after goalMaxTurns', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-goal-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [(payload, requests) => ({ content: requests.length % 2 ? 'Tried.' : 'NOT_MET\nStill failing.' })]);
  let out = '';
  const { exitCode, summary } = await runHeadless({ prompt: 'Goal: x', goal: 'x', goalMaxTurns: 2, root, config, outputFormat: 'json', sessionOptions: { settings }, write: (text) => { out += text; } });
  assert.equal(exitCode, 1);
  assert.equal(summary.subtype, 'error_goal_not_met');
  assert.equal(summary.goal.turns, 2);
  assert.equal(summary.goal.met, false);
  assert.match(summary.goal.reason, /Still failing/);
});

test('a resumed session mentions its paused goal', async () => {
  const { pausedGoalNotice } = await import('../src/cli.mjs');
  assert.match(pausedGoalNotice({ condition: 'npm test passes', paused: true, turns: 3 }), /Paused goal: npm test passes \(3 turn\(s\) so far\)\. \/goal resume/);
  assert.equal(pausedGoalNotice({ condition: 'x', achieved: true, paused: false }), '');
  assert.equal(pausedGoalNotice(null), '');
});
