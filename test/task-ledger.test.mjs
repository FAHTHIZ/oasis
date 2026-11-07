import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTaskLedger,
  addStep,
  startStep,
  completeStep,
  failStep,
  recordEvidence,
  recordChangedFile,
  requireVerification,
  recordVerification,
  addBlocker,
  resolveBlocker,
  nextStep,
  snapshotLedger,
  restoreLedger
} from '../src/task-ledger.mjs';

test('task ledger plans, executes, and completes dependent steps', () => {
  const ledger = createTaskLedger({ goal: 'Fix login bug' });
  const investigate = addStep(ledger, { title: 'Investigate bug' });
  const fix = addStep(ledger, { title: 'Apply fix', dependsOn: [investigate.id] });
  const verify = addStep(ledger, { title: 'Verify fix', dependsOn: [fix.id] });

  assert.equal(nextStep(ledger).id, investigate.id);
  startStep(ledger, investigate.id);
  completeStep(ledger, investigate.id);
  assert.equal(nextStep(ledger).id, fix.id);
  startStep(ledger, fix.id);
  completeStep(ledger, fix.id);
  assert.equal(nextStep(ledger).id, verify.id);
  startStep(ledger, verify.id);
  completeStep(ledger, verify.id);
  assert.equal(nextStep(ledger), null);
});

test('task ledger records evidence and changed files', () => {
  const ledger = createTaskLedger({ goal: 'Add feature' });
  const step = addStep(ledger, { title: 'Implement feature' });
  startStep(ledger, step.id);
  recordEvidence(ledger, { kind: 'tool_result', stepId: step.id, summary: 'Edited file', data: { path: 'src/a.js' } });
  recordChangedFile(ledger, 'src/a.js');
  assert.equal(ledger.evidence.length, 1);
  assert.deepEqual([...ledger.changedFiles], ['src/a.js']);
  assert.deepEqual(ledger.steps[0].evidence, [ledger.evidence[0].id]);
});

test('verification requirements track pass and failure states', () => {
  const ledger = createTaskLedger({ goal: 'Ship change' });
  requireVerification(ledger, { name: 'unit tests', command: 'npm test' });
  requireVerification(ledger, { name: 'lint', command: 'npm run lint' });
  recordVerification(ledger, 'unit tests', true);
  assert.equal(ledger.verification.status, 'pending');
  recordVerification(ledger, 'lint', false);
  assert.equal(ledger.verification.status, 'failed');
});

test('blockers pause progress and resolution restores it', () => {
  const ledger = createTaskLedger({ goal: 'Deploy service' });
  const step = addStep(ledger, { title: 'Deploy' });
  startStep(ledger, step.id);
  const blocker = addBlocker(ledger, { reason: 'Missing credentials', stepId: step.id });
  assert.equal(ledger.status, 'blocked');
  resolveBlocker(ledger, blocker.id, 'Credentials added');
  assert.equal(ledger.status, 'in_progress');
});

test('failed steps mark the task failed', () => {
  const ledger = createTaskLedger({ goal: 'Fix bug' });
  const step = addStep(ledger, { title: 'Try fix' });
  startStep(ledger, step.id);
  failStep(ledger, step.id, 'Tests failed');
  assert.equal(ledger.status, 'failed');
});

test('ledger snapshots restore full state', () => {
  const ledger = createTaskLedger({ goal: 'Refactor module' });
  const step = addStep(ledger, { title: 'Refactor' });
  startStep(ledger, step.id);
  recordEvidence(ledger, { kind: 'decision', summary: 'Chose adapter pattern' });
  const snapshot = snapshotLedger(ledger);
  const restored = restoreLedger(snapshot);
  assert.equal(restored.goal, ledger.goal);
  assert.equal(restored.steps.length, 1);
  assert.equal(restored.evidence.length, 1);
});
