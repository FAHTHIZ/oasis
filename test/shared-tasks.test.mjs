import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedTaskStore, runSharedTaskTool, sanitizeSharedTaskStore } from '../src/shared-tasks.mjs';

test('shared board supports creation, filtering, reading, ownership and updates', () => {
  const session = { sharedTasks: createSharedTaskStore(), agentId: 'agent_2' };
  const first = runSharedTaskTool(session, 'task_create', { subject: 'Inspect runtime', description: 'Find the implementation seam', owner: 'agent_2' });
  assert.equal(first.task.id, 'task_1');
  assert.equal(first.task.created_by, 'agent_2');
  const second = runSharedTaskTool(session, 'task_create', { subject: 'Verify behavior', blocked_by: ['task_1'] });
  assert.deepEqual(second.task.blocked_by, ['task_1']);
  assert.equal(second.task.ready, false);
  assert.throws(() => runSharedTaskTool(session, 'task_update', { task_id: 'task_2', status: 'in_progress' }), /blocked by task_1/);
  runSharedTaskTool(session, 'task_update', { task_id: 'task_1', status: 'in_progress' });
  runSharedTaskTool(session, 'task_update', { task_id: 'task_1', status: 'completed' });
  assert.equal(runSharedTaskTool(session, 'task_get', { task_id: 'task_2' }).task.ready, true);
  runSharedTaskTool(session, 'task_update', { task_id: 'task_2', status: 'in_progress', owner: 'main' });
  assert.equal(runSharedTaskTool(session, 'task_list', { owner: 'main' }).tasks[0].id, 'task_2');
  runSharedTaskTool(session, 'task_update', { task_id: 'task_2', status: 'completed' });
  assert.equal(runSharedTaskTool(session, 'task_list', { status: 'completed' }).total, 2);
});

test('shared task dependencies reject cycles and protect active downstream work', () => {
  const session = { sharedTasks: createSharedTaskStore() };
  runSharedTaskTool(session, 'task_create', { subject: 'A' });
  runSharedTaskTool(session, 'task_create', { subject: 'B', blocked_by: ['task_1'] });
  assert.throws(() => runSharedTaskTool(session, 'task_update', { task_id: 'task_1', blocked_by: ['task_2'] }), /cycle/);
  runSharedTaskTool(session, 'task_update', { task_id: 'task_1', status: 'completed' });
  runSharedTaskTool(session, 'task_update', { task_id: 'task_2', status: 'in_progress' });
  assert.throws(() => runSharedTaskTool(session, 'task_update', { task_id: 'task_1', status: 'pending' }), /dependent tasks/);
});

test('shared board validates limits, prerequisites and normalizes persisted data', () => {
  const session = { sharedTasks: createSharedTaskStore() };
  assert.throws(() => runSharedTaskTool(session, 'task_create', { subject: '   ' }), /cannot be empty/);
  assert.throws(() => runSharedTaskTool(session, 'task_create', { subject: 'A', blocked_by: ['task_404'] }), /Unknown dependency/);
  const restored = sanitizeSharedTaskStore({ nextId: 1, tasks: [
    { id: 'task_2', subject: 'Later', status: 'in_progress', blockedBy: ['task_1'], createdBy: 'agent_1' },
    { id: 'task_1', subject: 'First', status: 'pending', blockedBy: ['task_2'], createdBy: 'main' },
    { id: 'bad-id', subject: 'Ignore me', status: 'pending' },
    { id: 'task_2', subject: 'Duplicate', status: 'completed' }
  ] });
  assert.equal(restored.tasks.length, 2);
  assert.ok(restored.tasks.every((task) => task.status === 'pending'));
  assert.deepEqual(restored.tasks.map((task) => [task.id, task.blockedBy]), [['task_2', ['task_1']], ['task_1', []]]);
  assert.equal(restored.nextId, 3);
});
