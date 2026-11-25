import test from 'node:test';
import assert from 'node:assert/strict';
import { SubagentTracker } from '../app/core/subagents.mjs';

test('the subagent tracker follows each agent through its lifecycle', () => {
  const tracker = new SubagentTracker();
  assert.equal(tracker.update({ type: 'agent.started', agent_id: 'a1', description: 'Map the auth code' }), true);
  tracker.update({ type: 'agent.background_started', agent_id: 'a2', description: 'Run the slow tests' });
  assert.equal(tracker.running, 2);
  tracker.update({ type: 'agent.completed', agent_id: 'a1', detail: 'Found 3 entry points\nin src/auth' });
  tracker.update({ type: 'agent.failed', agent_id: 'a2', detail: 'npm test exited 1' });
  assert.deepEqual(tracker.list().map((w) => [w.id, w.description, w.status, w.detail]), [
    ['a1', 'Map the auth code', 'completed', 'Found 3 entry points in src/auth'],
    ['a2', 'Run the slow tests', 'failed', 'npm test exited 1']
  ]);
  assert.equal(tracker.running, 0);
});

test('events without an agent id are ignored, and dispatches keep the description', () => {
  const tracker = new SubagentTracker();
  assert.equal(tracker.update({ type: 'team.created', team_id: 't1' }), false);
  tracker.update({ type: 'agent.started', agent_id: 'w1', description: 'Reviewer' });
  tracker.update({ type: 'task.dispatched', agent_id: 'w1', description: 'task-7' });
  assert.equal(tracker.list()[0].description, 'Reviewer');
  assert.equal(tracker.list()[0].status, 'running');
  tracker.update({ type: 'agent.completed', agent_id: 'w1', detail: 'tool_calls=0 duration_ms=812' });
  assert.equal(tracker.list()[0].detail, '');
});

test('the tracker shows budget and a waiting approval until it is answered', () => {
  const tracker = new SubagentTracker();
  tracker.update({ type: 'agent.background_started', agent_id: 'agent_1', description: 'Run the build', budget: 'tokens 1,200/50,000' });
  tracker.update({ type: 'agent.approval_pending', agent_id: 'agent_1', detail: 'approval_0123abcd run_command' });
  tracker.update({ type: 'agent.completed', agent_id: 'agent_1', detail: 'Build waits for approval', budget: 'tokens 4,000/50,000' });
  let [worker] = tracker.list();
  assert.equal(worker.status, 'completed');
  assert.equal(worker.waitingApproval, true);
  assert.equal(worker.budget, 'tokens 4,000/50,000');
  assert.equal(worker.detail, 'Build waits for approval', 'approval ids stay out of the detail line');
  tracker.update({ type: 'agent.approval_granted', agent_id: 'agent_1', detail: 'approval_0123abcd run_command' });
  [worker] = tracker.list();
  assert.equal(worker.waitingApproval, false);
});

test('a running subagent row shows the step it is on and how many it finished', () => {
  const tracker = new SubagentTracker();
  tracker.update({ type: 'agent.started', agent_id: 'a1', description: 'Review cart.js' });
  assert.equal(tracker.step('Review cart.js', 'Reading cart.js'), true);
  assert.equal(tracker.list()[0].activity, 'Reading cart.js');
  tracker.step('Review cart.js', '', { finished: true });
  tracker.step('Review cart.js', 'Running npm test');
  assert.equal(tracker.list()[0].activity, 'Running npm test');
  assert.equal(tracker.list()[0].steps, 1);
  assert.equal(tracker.step('Someone else', 'Reading x'), false);
  tracker.update({ type: 'agent.completed', agent_id: 'a1', description: 'Review cart.js', detail: 'tool_calls=2' });
  assert.equal(tracker.list()[0].activity, '');
});

test('the tracker keeps each agent\'s steps and times, and marks an open approval', async () => {
  const { SubagentTracker } = await import('../app/core/subagents.mjs');
  const tracker = new SubagentTracker();
  tracker.update({ agent_id: 'agent_1', type: 'agent.started', description: 'Count lines' }, { at: 100 });
  tracker.step('Count lines', 'Running wc -l *.js', { at: 200, name: 'run_command' });
  assert.equal(tracker.waiting('Count lines', true), true);
  assert.equal(tracker.list()[0].waitingApproval, true);
  tracker.waiting('Count lines', false);
  tracker.step('Count lines', '', { finished: true, at: 400, ok: true });
  assert.equal(tracker.list()[0].activity, 'Thinking about the next step', 'a finished step is not shown as still running');
  tracker.update({ agent_id: 'agent_1', type: 'agent.completed', report: 'cart.js: 12', detail: 'tool_calls=1' }, { at: 500 });
  const [worker] = tracker.list();
  assert.equal(worker.startedAt, 100);
  assert.equal(worker.endedAt, 500);
  assert.equal(worker.detail, 'cart.js: 12', 'the report preview, not the counters');
  assert.deepEqual(worker.log.map((item) => [item.label, item.startedAt, item.endedAt, item.ok]), [['Running wc -l *.js', 200, 400, true]]);
});

test('a quiet agent says why: queued on the endpoint, or waiting out a retry', async () => {
  const { SubagentTracker } = await import('../app/core/subagents.mjs');
  const t = new SubagentTracker();
  t.update({ agent_id: 'a1', type: 'agent.started', description: 'Run npm test' }, { at: 1000 });
  assert.ok(t.pause('Run npm test', 'Waiting its turn on the model'));
  assert.equal(t.list()[0].activity, 'Waiting its turn on the model');
  assert.ok(t.pause('Run npm test', ''));
  assert.notEqual(t.list()[0].activity, 'Waiting its turn on the model');
  t.pause('Run npm test', 'Model busy, trying again in 5s', { until: 5000 });
  assert.equal(t.list({ now: 4000 })[0].activity, 'Model busy, trying again in 5s');
  assert.notEqual(t.list({ now: 6000 })[0].activity, 'Model busy, trying again in 5s');
  // A new step replaces the note.
  t.pause('Run npm test', 'Waiting its turn on the model');
  t.step('Run npm test', 'Reading cart.test.js');
  assert.equal(t.list()[0].activity, 'Reading cart.test.js');
  // Finished agents never show a pause note.
  t.pause('Run npm test', 'Waiting its turn on the model');
  t.update({ agent_id: 'a1', type: 'agent.completed' });
  assert.equal(t.pause('Run npm test', 'x'), false);
});

test('a second delegation step shows only the agents it started', async () => {
  const { workersByStep } = await import('../app/core/subagents.mjs');
  const homes = new Map();
  const first = { name: 'first' };
  const second = { name: 'second' };
  const a = { id: 'a', status: 'running' };
  let split = workersByStep(homes, [a], first);
  assert.deepEqual([...split.keys()], [first]);
  const aDone = { id: 'a', status: 'completed' };
  const b = { id: 'b', status: 'running' };
  split = workersByStep(homes, [aDone, b], second);
  assert.deepEqual(split.get(first), [aDone], 'the earlier step keeps its agent and gets its update');
  assert.deepEqual(split.get(second), [b]);
});

test('a JSON-wrapped subagent report shows as its text', async () => {
  const { plainReport } = await import('../app/core/subagents.mjs');
  assert.equal(plainReport('{"summary":"• one\\n• two"}'), '• one\n• two');
  assert.equal(plainReport('{"summary":"x","files":["a"]}'), '{"summary":"x","files":["a"]}');
  assert.equal(plainReport('Plain words.'), 'Plain words.');
  assert.equal(plainReport('{"summary": 3}'), '{"summary": 3}');
});
