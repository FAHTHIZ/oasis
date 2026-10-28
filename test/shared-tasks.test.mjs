import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedTaskStore, runSharedTaskTool, sanitizeSharedTaskStore } from '../src/shared-tasks.mjs';

test('shared board supports creation, dependencies, claims, ownership and completion', () => {
  const session = { sharedTasks: createSharedTaskStore(), agentId: 'agent_2' };
  const first = runSharedTaskTool(session, 'task_create', { subject: 'Inspect runtime', description: 'Find the implementation seam', owner: 'agent_2' });
  assert.equal(first.task.id, 'task_1');
  assert.equal(first.task.created_by, 'agent_2');
  const second = runSharedTaskTool(session, 'task_create', { subject: 'Verify behavior', blocked_by: ['task_1'] });
  assert.deepEqual(second.task.blocked_by, ['task_1']);
  assert.equal(second.task.ready, false);
  assert.throws(() => runSharedTaskTool(session, 'task_claim', { task_id: 'task_2' }), /blocked by task_1/);

  runSharedTaskTool(session, 'task_claim', { task_id: 'task_1' });
  assert.equal(session.sharedTasks.tasks[0].status, 'in_progress');
  runSharedTaskTool(session, 'task_update', { task_id: 'task_1', status: 'completed' });
  assert.equal(session.sharedTasks.tasks[0].claimedBy, '');
  assert.equal(runSharedTaskTool(session, 'task_get', { task_id: 'task_2' }).task.ready, true);

  session.agentId = 'main';
  const claim = runSharedTaskTool(session, 'task_claim', { task_id: 'task_2' });
  assert.equal(claim.task.owner, 'main');
  assert.equal(claim.task.claimed_by, 'main');
  runSharedTaskTool(session, 'task_update', { task_id: 'task_2', status: 'completed' });
  assert.equal(runSharedTaskTool(session, 'task_list', { status: 'completed' }).total, 2);
});

test('exclusive claims prevent duplicate work and expired leases can be reclaimed', () => {
  const sharedTasks = createSharedTaskStore();
  const main = { sharedTasks };
  runSharedTaskTool(main, 'task_create', { subject: 'Implement API' });
  runSharedTaskTool(main, 'task_create', { subject: 'Add tests' });
  const agent1 = { sharedTasks, agentId: 'agent_1' };
  const agent2 = { sharedTasks, agentId: 'agent_2' };

  const claim = runSharedTaskTool(agent1, 'task_claim', { task_id: 'task_1', lease_seconds: 60 });
  assert.equal(claim.task.claimed_by, 'agent_1');
  assert.equal(claim.task.status, 'in_progress');
  assert.throws(() => runSharedTaskTool(agent2, 'task_claim', { task_id: 'task_1' }), /claimed by agent_1/);
  assert.throws(() => runSharedTaskTool(agent2, 'task_update', { task_id: 'task_1', status: 'completed' }), /claimed by agent_1/);

  sharedTasks.tasks[0].claimExpiresAt = new Date(Date.now() - 1000).toISOString();
  const takeover = runSharedTaskTool(agent2, 'task_claim', { task_id: 'task_1', lease_seconds: 30 });
  assert.equal(takeover.reclaimed_from, 'agent_1');
  assert.equal(takeover.task.claimed_by, 'agent_2');
  runSharedTaskTool(agent2, 'task_update', { task_id: 'task_1', status: 'completed' });
  assert.equal(sharedTasks.tasks[0].claimExpiresAt, null);

  runSharedTaskTool(agent1, 'task_claim', { task_id: 'task_2', lease_seconds: 30 });
  const released = runSharedTaskTool(agent1, 'task_release', { task_id: 'task_2' });
  assert.equal(released.task.status, 'pending');
  assert.equal(released.task.claimed_by, null);
  assert.equal(released.task.ready, true);
  assert.throws(() => runSharedTaskTool(agent1, 'task_claim', { task_id: 'task_2', lease_seconds: 29 }), /lease_seconds/);
});

test('dependency cycles are rejected and completed prerequisites cannot be reopened under active downstream work', () => {
  const session = { sharedTasks: createSharedTaskStore() };
  runSharedTaskTool(session, 'task_create', { subject: 'A' });
  runSharedTaskTool(session, 'task_create', { subject: 'B', blocked_by: ['task_1'] });
  assert.throws(() => runSharedTaskTool(session, 'task_update', { task_id: 'task_1', blocked_by: ['task_2'] }), /cycle/);
  runSharedTaskTool(session, 'task_claim', { task_id: 'task_1' });
  runSharedTaskTool(session, 'task_update', { task_id: 'task_1', status: 'completed' });
  runSharedTaskTool(session, 'task_claim', { task_id: 'task_2' });
  assert.throws(() => runSharedTaskTool(session, 'task_update', { task_id: 'task_1', status: 'pending' }), /dependent tasks/);
});

test('shared board validates limits, blocks unauthorized status transitions and normalizes persisted data', () => {
  const session = { sharedTasks: createSharedTaskStore() };
  assert.throws(() => runSharedTaskTool(session, 'task_create', { subject: '   ' }), /cannot be empty/);
  assert.throws(() => runSharedTaskTool(session, 'task_create', { subject: 'A', blocked_by: ['task_404'] }), /Unknown dependency/);
  const task = runSharedTaskTool(session, 'task_create', { subject: 'A' });
  assert.throws(() => runSharedTaskTool({ sharedTasks: session.sharedTasks, agentId: 'agent_1' }, 'task_update', { task_id: task.task.id, status: 'completed' }), /task_claim/);

  const restored = sanitizeSharedTaskStore({ nextId: 1, tasks: [
    { id: 'task_2', subject: 'Later', status: 'in_progress', blockedBy: ['task_1'], claimedBy: 'agent_2', claimExpiresAt: new Date(Date.now() + 60000).toISOString(), createdBy: 'agent_1' },
    { id: 'task_1', subject: 'First', status: 'pending', blockedBy: ['task_2'], claimedBy: 'agent_1', claimExpiresAt: new Date(Date.now() + 60000).toISOString(), createdBy: 'main' },
    { id: 'bad-id', subject: 'Ignore me', status: 'pending' },
    { id: 'task_2', subject: 'Duplicate', status: 'completed' }
  ] });
  assert.equal(restored.tasks.length, 2);
  assert.ok(restored.tasks.every((item) => item.status === 'pending'));
  assert.ok(restored.tasks.every((item) => item.claimedBy === '' && item.claimExpiresAt === null));
  assert.deepEqual(restored.tasks.map((item) => [item.id, item.blockedBy]), [['task_2', ['task_1']], ['task_1', []]]);
  assert.equal(restored.nextId, 3);
});
