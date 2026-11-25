import test from 'node:test';
import assert from 'node:assert/strict';
import { SubagentTracker } from '../app/core/subagents.mjs';
import { agentLanes } from '../app/core/trace.mjs';

// The card said "Thinking about the next step… · 1 step done" for minutes
// with no word on how npm test went; now the step's result line is kept.
test('a subagent step keeps its one-line result for the card and its lane', () => {
  const tracker = new SubagentTracker();
  tracker.update({ type: 'agent.started', agent_id: 'agent_1', description: 'npm test' });
  tracker.step('npm test', 'Running npm test', { name: 'run_command', at: 1000 });
  tracker.step('npm test', '', { finished: true, at: 2000, brief: '✓ exit 0 · 3 passed, 0 failed' });
  const [worker] = tracker.list();
  assert.equal(worker.lastBrief, '✓ exit 0 · 3 passed, 0 failed');
  const [lane] = agentLanes([worker], 3000);
  assert.equal(lane.steps[0].brief, '✓ exit 0 · 3 passed, 0 failed');
});
