import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_TOOL_NAMES,
  neuronNetworkSnapshot,
  registerAgent,
  restoreAgentHistory,
  summarizeAgent
} from '../src/agent-tasks.mjs';
import { sanitizeAgentHistory } from '../src/sessions.mjs';

test('agent registration records coordinator and parent-child lineage', () => {
  const main = { agentRunId: 'run-1' };
  const parent = registerAgent(main, { type: 'explore', description: 'Repository mapper' });
  const childSession = { agentTasks: main.agentTasks, agentId: parent.id, agentRunId: 'run-1' };
  const child = registerAgent(childSession, { type: 'code-review', description: 'Independent reviewer' });

  assert.equal(parent.parentId, 'main');
  assert.equal(parent.depth, 1);
  assert.equal(child.parentId, parent.id);
  assert.equal(child.depth, 2);
  assert.equal(summarizeAgent(child).parent_id, parent.id);
  assert.equal(summarizeAgent(child).depth, 2);
});

test('network inspection exposes a bounded graph and aggregate usage without reports', () => {
  const main = {};
  const parent = registerAgent(main, { type: 'general-purpose', description: 'Implement feature' });
  const childSession = { agentTasks: main.agentTasks, agentId: parent.id };
  const child = registerAgent(childSession, { type: 'security-review', description: 'Review implementation' });
  // Deliberately make the child look older: graph order must follow lineage, not clocks.
  parent.startedAt = Date.now();
  child.startedAt = parent.startedAt - 1000;
  child.status = 'completed';
  child.finishedAt = Date.now();
  child.report = 'This private report must not appear in the network projection.';
  child.toolCalls = 7;
  child.usage = { requests: 2, inputTokens: 120, outputTokens: 80, totalTokens: 200, costUsd: 0.004, costKnown: true };

  const snapshot = neuronNetworkSnapshot(main, { limit: 10 });
  assert.equal(snapshot.network, 'Oasis Neuron Network');
  assert.equal(snapshot.root_id, 'main');
  assert.ok(snapshot.nodes.some((node) => node.id === 'main'));
  assert.deepEqual(snapshot.edges, [
    { from: 'main', to: parent.id, relation: 'spawned' },
    { from: parent.id, to: child.id, relation: 'spawned' }
  ]);
  assert.equal(snapshot.summary.total_agents, 2);
  assert.equal(snapshot.summary.completed_agents, 1);
  assert.equal(snapshot.summary.total_tool_calls, 7);
  assert.equal(snapshot.summary.total_tokens, 200);
  assert.equal(snapshot.summary.estimated_cost_usd, 0.004);
  assert.ok(!JSON.stringify(snapshot).includes('private report'));
  assert.equal(neuronNetworkSnapshot(main, { status: 'running' }).summary.visible_agents, 1);
  const filtered = neuronNetworkSnapshot(main, { parent_id: parent.id });
  assert.equal(filtered.summary.visible_agents, 1);
  assert.equal(filtered.summary.context_agents, 1);
  assert.deepEqual(filtered.nodes.map((node) => node.id), ['main', parent.id, child.id]);
  assert.equal(filtered.nodes.find((node) => node.id === parent.id).context_only, true);
  const nodeIds = new Set(filtered.nodes.map((node) => node.id));
  assert.ok(filtered.edges.every((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)), 'filtered graph edges must never reference omitted nodes');
  assert.throws(() => neuronNetworkSnapshot(childSession), /Only the main coordinator/);
  assert.throws(() => neuronNetworkSnapshot(main, { status: 'unknown' }), /status must be/);
  assert.ok(AGENT_TOOL_NAMES.has('neuron_network'));
});

test('lineage survives sanitized session history restoration', () => {
  const main = {};
  const parent = registerAgent(main, { type: 'explore', description: 'Parent worker' });
  const childSession = { agentTasks: main.agentTasks, agentId: parent.id };
  const child = registerAgent(childSession, { type: 'plan', description: 'Child worker' });

  const snapshots = sanitizeAgentHistory(main.agentTasks);
  assert.equal(snapshots.find((item) => item.id === child.id).parentId, parent.id);
  assert.equal(snapshots.find((item) => item.id === child.id).depth, 2);

  const restoredSession = {};
  const restored = restoreAgentHistory(restoredSession, snapshots);
  const restoredChild = restored.find((item) => item.id === child.id);
  assert.ok(restoredChild);
  assert.equal(restoredChild.parentId, parent.id);
  assert.equal(restoredChild.depth, 2);
});
