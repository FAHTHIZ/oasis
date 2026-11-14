import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { selectTaskModel, sanitizeModelRouting } from '../src/model-routing.mjs';
import { canEscalate, escalate, newEscalation } from '../src/escalation.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { loadSettings } from '../src/settings.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

async function temporaryDirectory(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-escalation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const cascade = { enabled: true, mode: 'cascade', easyModel: 'cheap-fixture', strongModel: 'strong-fixture' };
const call = (id, name, args) => ({ content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });

test('cascade starts coding work on the cheaper model but keeps pinned tasks strong', () => {
  const work = selectTaskModel('Fix the off-by-one bug in src/parser.js and add a test.', 'strong-fixture', cascade);
  assert.equal(work.tier, 'work');
  assert.equal(work.mode, 'cascade');
  assert.equal(work.model, 'cheap-fixture');
  assert.equal(work.escalateTo, 'strong-fixture');
  assert.match(work.reason, /^cascade: starts on cheap-fixture and moves to strong-fixture/);

  const security = selectTaskModel('Review the authentication code for a security issue.', 'strong-fixture', cascade);
  assert.equal(security.tier, 'strong');
  assert.equal(security.model, 'strong-fixture');
  assert.equal(security.escalateTo, undefined);
  assert.equal(selectTaskModel('Change the demo file.', 'strong-fixture', cascade, { hint: 'hard' }).tier, 'strong');
  // Easy read-only work still goes to the cheaper model, with nothing to escalate.
  assert.equal(selectTaskModel('Summarize the README in three bullets.', 'strong-fixture', cascade).tier, 'easy');
  // Without cascade, or with one model for both roles, behaviour is unchanged.
  assert.equal(selectTaskModel('Fix the bug in src/parser.js.', 'strong-fixture', { ...cascade, mode: undefined }).tier, 'strong');
  assert.equal(selectTaskModel('Fix the bug in src/parser.js.', 'm', { enabled: true, mode: 'cascade', easyModel: 'm', strongModel: 'm' }).tier, 'strong');
});

test('escalation happens once, and zero-budget mode never escalates to a model not proven free', () => {
  const route = { tier: 'work', model: 'cheap', escalateTo: 'strong' };
  const state = newEscalation(route, { session: { config: { baseURL: 'https://api.example.test/v1' } }, env: {} });
  assert.equal(canEscalate(state), true);
  const note = escalate(state, { evidence: 'I’m stuck: the same read_file call repeated.', step: 4, signal: 'loop-breaker' });
  assert.match(note, /handed this task from cheap to you \(strong\) because the run was stuck: the same read_file call repeated\./);
  assert.deepEqual(state.done, { step: 4, signal: 'loop-breaker', from: 'cheap', to: 'strong', reason: 'the same read_file call repeated.' });
  assert.equal(escalate(state, { evidence: 'again', step: 6 }), '', 'a second escalation in the same task is refused');

  const zero = newEscalation(route, { session: { config: { baseURL: 'https://api.example.test/v1' } }, env: { OASIS_ZERO_BUDGET: '1' } });
  assert.equal(canEscalate(zero), false);
  assert.match(zero.skipped, /^zero-budget mode: strong is unknown/);
  const declared = newEscalation(route, { session: { config: { baseURL: 'https://api.example.test/v1' } }, env: { OASIS_ZERO_BUDGET: '1', OASIS_FREE_MODELS: 'strong' } });
  assert.equal(canEscalate(declared), true);
  assert.match(newEscalation(route, { allowed: () => false }).skipped, /not in availableModels/);
  assert.equal(newEscalation({ tier: 'strong', model: 'strong' }), null);
});

test('a stuck cheap model hands the rest of the task to the strong model instead of stopping', async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(path.join(root, 'loop.txt'), 'The same stable result.\n');
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') };
  const { config, requests } = await scriptedModel(t, [
    call('r1', 'read_file', { path: 'loop.txt' }),
    call('r2', 'read_file', { path: 'loop.txt' }),
    call('r3', 'read_file', { path: 'loop.txt' }),
    { content: 'loop.txt holds one stable line of text.' }
  ]);
  config.model = 'strong-fixture';
  const session = await createSession({ root, config, bare: true, env });
  session.settings.modelRouting = { ...cascade };
  t.after(() => closeSession(session));
  const events = [];
  const result = await runAgentTurn(session, 'Fix the wording in loop.txt so it explains itself.', { env, onEscalate: (event) => events.push(event) });

  assert.deepEqual(requests.map((r) => r.model), ['cheap-fixture', 'cheap-fixture', 'cheap-fixture', 'strong-fixture']);
  assert.notEqual(result.stoppedByLoopBreaker, true);
  assert.match(result.text, /stable line/);
  const handover = JSON.stringify(requests[3].messages);
  assert.match(handover, /handed this task from cheap-fixture to you \(strong-fixture\) because the run was stuck/);
  assert.equal(result.modelRouting.tier, 'work');
  assert.deepEqual({ ...result.modelRouting.escalation, reason: undefined }, { step: 3, signal: 'loop-breaker', from: 'cheap-fixture', to: 'strong-fixture', reason: undefined });
  assert.equal(events.length, 1);
  assert.equal(session.config.model, 'strong-fixture');
});

test('the same failure surviving three rounds of edits escalates before the loop gives up', async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(path.join(root, 'check.mjs'), "console.error('expected 3, got 2'); process.exit(1);\n");
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') };
  const run = (id) => call(id, 'run_command', { command: 'node', args: ['check.mjs'] });
  const edit = (id, n) => call(id, 'write_file', { path: 'value.txt', content: 'attempt ' + n + '\n' });
  const { config, requests } = await scriptedModel(t, [
    run('c1'), edit('e1', 1), run('c2'), edit('e2', 2), run('c3'),
    { content: 'The check reads a hard-coded value; I need the real input to fix it.' }
  ]);
  config.model = 'strong-fixture';
  const session = await createSession({ root, config, bare: true, env });
  session.settings.modelRouting = { ...cascade };
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'Fix check.mjs so it passes.', { env, autoApprove: true });

  assert.deepEqual(requests.map((r) => r.model), ['cheap-fixture', 'cheap-fixture', 'cheap-fixture', 'cheap-fixture', 'cheap-fixture', 'strong-fixture']);
  assert.equal(result.modelRouting.escalation.signal, 'thrash');
  assert.match(result.modelRouting.escalation.reason, /`node check\.mjs` survived 3 rounds of edits/);
  assert.doesNotMatch(JSON.stringify(requests[5].messages), /Your last 3 edits did not change this failure/, 'the hand-over replaces the self-correction nudge');
});

test('in zero-budget mode a stuck run stops as before when the strong model is not proven free', async (t) => {
  const root = await temporaryDirectory(t);
  await writeFile(path.join(root, 'loop.txt'), 'The same stable result.\n');
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config'), OASIS_ZERO_BUDGET: '1', OASIS_FREE_MODELS: 'cheap-fixture' };
  const { config, requests } = await scriptedModel(t, [
    call('r1', 'read_file', { path: 'loop.txt' }),
    call('r2', 'read_file', { path: 'loop.txt' }),
    call('r3', 'read_file', { path: 'loop.txt' }),
    { content: 'unreachable' }
  ]);
  config.model = 'strong-fixture';
  const session = await createSession({ root, config, bare: true, env });
  session.settings.modelRouting = { ...cascade };
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'Fix the wording in loop.txt.', { env });

  assert.equal(result.stoppedByLoopBreaker, true);
  assert.deepEqual(requests.map((r) => r.model), ['cheap-fixture', 'cheap-fixture', 'cheap-fixture']);
  assert.equal(result.modelRouting.escalation, null);
  assert.match(result.modelRouting.escalationSkipped, /^zero-budget mode: strong-fixture is unknown/);
});

test('cascade mode is a saved setting and a /routing command', async (t) => {
  assert.equal(sanitizeModelRouting({ ...cascade }).mode, 'cascade');
  assert.equal(sanitizeModelRouting({ ...cascade, mode: 'bogus' }).mode, undefined);
  const root = await temporaryDirectory(t);
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') };
  const session = { root, config: { model: 'strong-model', protocol: 'openai-compatible', baseURL: 'https://api.example.test/v1' }, settings: { modelRouting: { enabled: false, easyModel: '', strongModel: '' } }, availableModels: null };
  const state = { root, session, env, sessionOptions: {} };
  assert.match((await runBuiltinCommand('routing', 'cascade', state)).output, /Set a cheaper model first/);
  await runBuiltinCommand('routing', 'easy cheap-model', state);
  const on = await runBuiltinCommand('routing', 'cascade', state);
  assert.match(on.output, /Cascade routing is on\. Tasks start on cheap-model and move to strong-model/);
  assert.equal((await loadSettings(root, { env })).modelRouting.mode, 'cascade');
  const back = await runBuiltinCommand('routing', 'classify', state);
  assert.match(back.output, /Automatic routing is on\. Clearly read-only requests use cheap-model/);
  assert.equal((await loadSettings(root, { env })).modelRouting.mode, undefined);
});
