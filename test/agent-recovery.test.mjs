import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { getAgent, listAgents, stopAgent } from '../src/agent-tasks.mjs';
import { autoRecoveryLimit, isTransientFailure, recoveryPlan, waitForRecovery } from '../src/agent-recovery.mjs';

test('transient failures are told apart from ones a restart would repeat', () => {
  assert.equal(isTransientFailure(Object.assign(new Error('The model stream stalled'), { code: 'OASIS_STREAM_INTERRUPTED' })), true);
  assert.equal(isTransientFailure(Object.assign(new Error('Provider error'), { status: 503 })), true);
  assert.equal(isTransientFailure(Object.assign(new Error('Too many requests'), { status: 429 })), true);
  assert.equal(isTransientFailure(new Error('fetch failed')), true);
  assert.equal(isTransientFailure(Object.assign(new Error('Bad request'), { status: 400 })), false);
  assert.equal(isTransientFailure(Object.assign(new Error('You exceeded your current quota, check your billing details'), { status: 429 })), false);
  assert.equal(isTransientFailure(new Error('The session budget of $0.50 is exhausted; request timed out')), false);
  assert.equal(isTransientFailure(new Error('Unknown tool foo')), false);
});

test('the restart limit comes from the environment, then the setting', () => {
  assert.equal(autoRecoveryLimit({}, {}), 1);
  assert.equal(autoRecoveryLimit({ subagentAutoRecover: 3 }, {}), 3);
  assert.equal(autoRecoveryLimit({ subagentAutoRecover: 3 }, { OASIS_SUBAGENT_AUTO_RECOVER: '0' }), 0);
  assert.equal(autoRecoveryLimit({}, { OASIS_SUBAGENT_AUTO_RECOVER: '9' }), 3);
  assert.equal(autoRecoveryLimit({}, { OASIS_SUBAGENT_AUTO_RECOVER: 'off' }), 0);
});

test('only safe-to-repeat runs get a restart plan', () => {
  const base = () => ({ status: 'stalled', stalled: 'No activity for 451s; the agent was stopped as stalled.', child: {}, resumable: true });
  const stalled = recoveryPlan({}, base(), new Error('aborted'), {});
  assert.equal(stalled.delayMs, 0);
  assert.equal(stalled.reason, 'stalled: No activity for 451s');
  assert.match(stalled.prompt, /restarted you automatically/);
  assert.match(stalled.prompt, /add a timeout/);
  const failed = recoveryPlan({}, { ...base(), status: 'failed' }, Object.assign(new Error('upstream 502'), { status: 502 }), {});
  assert.ok(failed.delayMs > 0);
  assert.doesNotMatch(failed.prompt, /add a timeout/);
  assert.equal(recoveryPlan({}, { ...base(), status: 'failed' }, new Error('Unknown tool'), {}), null);
  assert.equal(recoveryPlan({}, { ...base(), cancelRequested: true }, new Error('x'), {}), null);
  assert.equal(recoveryPlan({}, { ...base(), resumable: false }, new Error('x'), {}), null, 'worktree already cleaned up');
  assert.equal(recoveryPlan({}, { ...base(), sharedTaskId: 'task_1' }, new Error('x'), {}), null, 'the task board re-dispatches its tasks');
  assert.equal(recoveryPlan({}, { ...base(), autoRecoveries: 1 }, new Error('x'), {}), null, 'once by default');
  assert.equal(recoveryPlan({ closed: true }, base(), new Error('x'), {}), null);
  assert.equal(recoveryPlan({}, base(), new Error('x'), { OASIS_SUBAGENT_AUTO_RECOVER: '0' }), null);
});

test('a stall on a model OASIS picked to save money restarts on the session model', () => {
  const parent = { config: { model: 'strong-model' } };
  const record = { status: 'stalled', stalled: 'No activity for 451s', resumable: true, modelRoute: 'experience: cheap-model succeeded on 9 of 10 runs', child: { config: { model: 'cheap-model' } } };
  const plan = recoveryPlan(parent, record, new Error('aborted'), {});
  assert.equal(plan.escalateTo, 'strong-model');
  assert.equal(plan.escalateFrom, 'cheap-model');
  assert.match(plan.prompt, /You now run on strong-model instead of cheap-model/);
  assert.equal(recoveryPlan(parent, { ...record, modelRoute: undefined }, new Error('x'), {}).escalateTo, undefined, 'an explicitly chosen model is kept');
  assert.equal(recoveryPlan(parent, { ...record, status: 'failed' }, Object.assign(new Error('upstream 502'), { status: 502 }), {}).escalateTo, undefined, 'an outage is not the model\'s fault');
  assert.equal(recoveryPlan(parent, { ...record, child: { config: { model: 'strong-model' } } }, new Error('x'), {}).escalateTo, undefined);
  assert.equal(recoveryPlan(parent, { ...record, escalatedFrom: 'cheap-model' }, new Error('x'), {}).escalateTo, undefined);
});

// A background agent whose first model request hangs is stopped by the stall
// monitor and restarted once from its own conversation; the second run answers.
async function backgroundHarness(t, { env: extraEnv = {}, childAnswers = true } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-recover-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const hanging = new Set();
  const childRequests = [];
  const childModels = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    if (/SUBAGENT MODE/.test(payload.messages[0].content)) {
      childRequests.push(payload.messages);
      childModels.push(payload.model);
      if (childRequests.length === 1 || !childAnswers) { hanging.add(res); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Finished the slow job.' } }] }));
      return;
    }
    const done = payload.messages.some((message) => message.role === 'tool');
    const message = done ? { role: 'assistant', content: 'started' }
      : { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'slow', prompt: 'do the slow job', run_in_background: true }) } }] };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { for (const res of hanging) res.destroy(); server.close(); });
  const env = { ...process.env, OASIS_SUBAGENT_STALL_SECONDS: '1', OASIS_AGENT_EXPERIENCE: '0', ...extraEnv };
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 4 } });
  await runAgentTurn(session, 'go', { autoApprove: true, env });
  const record = getAgent(session, listAgents(session)[0].id);
  return { session, record, childRequests, childModels };
}

test('a stalled background agent is restarted once and its report reaches the parent', async (t) => {
  const { session, record, childRequests } = await backgroundHarness(t);
  await record.promise;
  assert.equal(record.status, 'completed');
  assert.equal(record.autoRecoveries, 1);
  assert.equal(record.report, 'Finished the slow job.');
  assert.equal(childRequests.length, 2);
  const restart = childRequests[1].filter((message) => message.role === 'user').at(-1);
  assert.match(String(restart.content), /OASIS stopped your previous run \(no progress: No activity for \d+s\)/);
  assert.ok(childRequests[1].some((message) => message.role === 'user' && /do the slow job/.test(String(message.content))), 'the restart keeps the original task');
  const notices = (session.inbox || []).map((entry) => entry.text);
  assert.equal(notices.length, 1, 'the parent hears once, when the agent is done');
  assert.match(notices[0], /finished after OASIS restarted it automatically \(stalled: No activity/);
});

test('a second stall is reported, and the setting can turn restarts off', async (t) => {
  const twice = await backgroundHarness(t, { childAnswers: false });
  await twice.record.promise;
  assert.equal(twice.record.status, 'stalled');
  assert.equal(twice.record.autoRecoveries, 1);
  assert.equal(twice.childRequests.length, 2);

  const off = await backgroundHarness(t, { env: { OASIS_SUBAGENT_AUTO_RECOVER: '0' } });
  await off.record.promise;
  assert.equal(off.record.status, 'stalled');
  assert.equal(off.record.autoRecoveries, undefined);
  assert.equal(off.childRequests.length, 1);
});

test('stopping an agent that waits for its restart keeps it stopped', async () => {
  const record = { id: 'agent_9', status: 'failed', recovering: { reason: 'failed: 502', at: Date.now() }, description: 'x' };
  const session = { agentRegistry: undefined };
  const { agentRegistry } = await import('../src/agent-tasks.mjs');
  agentRegistry(session).agents.set(record.id, record);
  const waiting = waitForRecovery(record, 5000);
  stopAgent(session, { id: record.id });
  assert.equal(record.cancelRequested, true);
  assert.equal(await waiting, false);
  assert.equal(recoveryPlan({}, { ...record, child: {}, resumable: true }, Object.assign(new Error('x'), { status: 502 }), {}), null);
});

test('the restart after a stall on a routed model uses the session model', async (t) => {
  const { record, childModels } = await backgroundHarness(t, { env: { OASIS_SUBAGENT_STALL_SECONDS: '2' } });
  // As if modelRouting.subagents = "experience" had picked a cheaper model.
  record.modelRoute = 'experience: cheap-fixture succeeded on 9 of 10 runs';
  record.child.config = { ...record.child.config, model: 'cheap-fixture' };
  await record.promise;
  assert.equal(record.status, 'completed');
  assert.equal(childModels.at(-1), 'fixture');
  assert.equal(record.escalatedFrom, 'cheap-fixture');
  assert.match(record.recoveredFrom[0], /moved from cheap-fixture to fixture/);
});
