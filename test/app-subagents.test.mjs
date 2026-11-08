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
