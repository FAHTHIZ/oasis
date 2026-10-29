import test from 'node:test';
import assert from 'node:assert/strict';
import { createSharedTaskStore, runSharedTaskTool, sanitizeSharedTaskStore, SHARED_TASK_TOOL_NAMES } from '../src/shared-tasks.mjs';

test('shared board supports creation, dependencies, claims, ownership and completion', () => {
  const session = { sharedTasks: createSharedTaskStore(), agentId: 'agent_2' };
  const first = runSharedTaskTool(session, 'task_create', { subject: 'Inspect runtime', description: 'Find the implementation seam', owner: 'agent_2' });
  assert.equal(first.task.id, 'task_1');
  assert.equal(first.task.created_by, 'agent_2');
  assert.ok(SHARED_TASK_TOOL_NAMES.has('task_renew'));
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
  const renewed = runSharedTaskTool(agent2, 'task_renew', { task_id: 'task_1', lease_seconds: 120 });
  assert.equal(renewed.renewed, true);
  assert.equal(renewed.lease_seconds, 120);
  assert.equal(renewed.task.claimed_by, 'agent_2');
  assert.ok(Date.parse(renewed.task.claim_expires_at) > Date.now() + 110000);
  assert.throws(() => runSharedTaskTool(agent1, 'task_renew', { task_id: 'task_1' }), /only that agent can renew/);
  assert.throws(() => runSharedTaskTool(agent2, 'task_renew', { task_id: 'task_1', lease_seconds: 29 }), /lease_seconds/);
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
    { id: 'task_2', subject: 'Later', status: 'in_progress', blockedBy: ['task_1'], claimedBy: 'agent_2', claimExpiresAt: new Date(Date.now() + 60000).toISOString(), createdBy: 'agent_1', worktreeChanged: true, worktreeBranch: 'oasis/safe-branch-123abc', worktreeCommit: '0123456789abcdef0123456789abcdef01234567' },
    { id: 'task_1', subject: 'First', status: 'pending', blockedBy: ['task_2'], claimedBy: 'agent_1', claimExpiresAt: new Date(Date.now() + 60000).toISOString(), createdBy: 'main' },
    { id: 'bad-id', subject: 'Ignore me', status: 'pending' },
    { id: 'task_2', subject: 'Duplicate', status: 'completed' }
  ] });
  assert.equal(restored.tasks.length, 2);
  assert.ok(restored.tasks.every((item) => item.status === 'pending'));
  assert.ok(restored.tasks.every((item) => item.claimedBy === '' && item.claimExpiresAt === null));
  assert.deepEqual(restored.tasks.map((item) => [item.id, item.blockedBy]), [['task_2', ['task_1']], ['task_1', []]]);
  assert.equal(restored.tasks[0].worktreeChanged, true);
  assert.equal(restored.tasks[0].worktreeBranch, 'oasis/safe-branch-123abc');
  assert.equal(restored.tasks[0].worktreeCommit, '0123456789abcdef0123456789abcdef01234567');
  assert.equal(restored.nextId, 3);
});

test('task checkpoints survive restoration when a worker lease is reset', () => {
  const session = { sharedTasks: createSharedTaskStore(), agentId: 'agent_7' };
  const created = runSharedTaskTool(session, 'task_create', { subject: 'Refactor provider retry handling' });
  assert.ok(SHARED_TASK_TOOL_NAMES.has('task_checkpoint'));
  runSharedTaskTool(session, 'task_claim', { task_id: created.task.id, lease_seconds: 60 });
  const saved = runSharedTaskTool(session, 'task_checkpoint', {
    task_id: created.task.id,
    summary: 'Updated retry policy in src/provider.mjs. Authorization: Bearer super-secret-token',
    completed_steps: ['Added transient-error classification'],
    next_steps: ['Add tests for 429 and timeout cases'],
    touched_files: ['src/provider.mjs', 'test/provider.test.mjs'],
    tests_run: ['node --test test/provider.test.mjs — 8 passed']
  });
  assert.equal(saved.saved, true);
  assert.doesNotMatch(saved.task.checkpoint.summary, /super-secret-token/);
  assert.match(saved.task.checkpoint.summary, /REDACTED/);

  const restored = sanitizeSharedTaskStore(session.sharedTasks);
  assert.equal(restored.tasks[0].status, 'pending');
  assert.equal(restored.tasks[0].claimedBy, '');
  assert.equal(restored.tasks[0].claimExpiresAt, null);
  assert.equal(restored.tasks[0].checkpoint.summary, saved.task.checkpoint.summary);
  assert.deepEqual(restored.tasks[0].checkpoint.nextSteps, ['Add tests for 429 and timeout cases']);

  const replacement = { sharedTasks: restored, agentId: 'agent_8' };
  const view = runSharedTaskTool(replacement, 'task_get', { task_id: created.task.id });
  assert.equal(view.task.checkpoint.touched_files.length, 2);
  assert.equal(view.task.checkpoint.tests_run[0], 'node --test test/provider.test.mjs — 8 passed');
  const claim = runSharedTaskTool(replacement, 'task_claim', { task_id: created.task.id });
  assert.equal(claim.task.claimed_by, 'agent_8');
  assert.equal(claim.task.checkpoint.summary, saved.task.checkpoint.summary);
});

test('task checkpoints require the active claimant and enforce bounds', () => {
  const session = { sharedTasks: createSharedTaskStore(), agentId: 'agent_1' };
  const created = runSharedTaskTool(session, 'task_create', { subject: 'Improve workspace safety' });
  assert.throws(() => runSharedTaskTool(session, 'task_checkpoint', {
    task_id: created.task.id, summary: 'Not claimed yet'
  }), /Claim task_1 before saving/);
  runSharedTaskTool(session, 'task_claim', { task_id: created.task.id });
  assert.throws(() => runSharedTaskTool(session, 'task_checkpoint', {
    task_id: created.task.id, summary: 'x'.repeat(2001)
  }), /must be at most 2000 characters/);
  assert.throws(() => runSharedTaskTool(session, 'task_checkpoint', {
    task_id: created.task.id, summary: 'Valid summary', next_steps: Array(21).fill('next')
  }), /at most 20 items/);
  assert.throws(() => runSharedTaskTool({ sharedTasks: session.sharedTasks, agentId: 'agent_2' }, 'task_checkpoint', {
    task_id: created.task.id, summary: 'A different agent should not overwrite this'
  }), /Only the active claimant may checkpoint/);
});
