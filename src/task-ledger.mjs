export const TASK_STATUSES = ['planning', 'in_progress', 'blocked', 'verifying', 'done', 'failed', 'cancelled'];
export const STEP_STATUSES = ['pending', 'in_progress', 'blocked', 'done', 'failed', 'skipped'];
export const EVIDENCE_KINDS = ['observation', 'tool_result', 'test_result', 'diff', 'command_output', 'decision', 'error', 'user_input'];

const now = () => new Date().toISOString();
const id = (prefix) => prefix + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

export function createTaskLedger({ goal = '', context = {} } = {}) {
  return { id: id('task'), goal: String(goal || ''), status: 'planning', context: { ...context }, steps: [], evidence: [], blockers: [], changedFiles: new Set(), verification: { required: [], passed: [], failed: [], status: 'pending' }, createdAt: now(), updatedAt: now(), version: 1 };
}

export function addStep(ledger, { title, detail = '', dependsOn = [] } = {}) {
  const step = { id: id('step'), title: String(title || '').trim(), status: 'pending', detail: String(detail || ''), dependsOn: [...dependsOn], evidence: [], startedAt: null, completedAt: null };
  if (!step.title) throw new Error('Task step requires a title.');
  ledger.steps.push(step);
  touch(ledger);
  return step;
}

export function startStep(ledger, stepId) {
  const step = requireStep(ledger, stepId);
  assertDependencies(ledger, step);
  step.status = 'in_progress';
  step.startedAt = now();
  if (ledger.status === 'planning') ledger.status = 'in_progress';
  touch(ledger);
  return step;
}

export function completeStep(ledger, stepId, detail = '') {
  const step = requireStep(ledger, stepId);
  step.status = 'done';
  step.completedAt = now();
  if (detail) step.detail = detail;
  touch(ledger);
  return step;
}

export function failStep(ledger, stepId, reason = '') {
  const step = requireStep(ledger, stepId);
  step.status = 'failed';
  if (reason) step.detail = reason;
  ledger.status = 'failed';
  touch(ledger);
  return step;
}

export function skipStep(ledger, stepId, reason = '') {
  const step = requireStep(ledger, stepId);
  step.status = 'skipped';
  if (reason) step.detail = reason;
  touch(ledger);
  return step;
}

export function recordEvidence(ledger, { kind, stepId = null, summary = '', data = null } = {}) {
  if (!EVIDENCE_KINDS.includes(kind)) throw new Error('Unknown evidence kind: ' + kind);
  const record = { id: id('ev'), kind, stepId, summary: String(summary || ''), data, createdAt: now() };
  ledger.evidence.push(record);
  if (stepId) requireStep(ledger, stepId).evidence.push(record.id);
  touch(ledger);
  return record;
}

export function recordChangedFile(ledger, path) {
  const value = String(path || '').trim();
  if (!value) throw new Error('Changed file path is required.');
  ledger.changedFiles.add(value);
  touch(ledger);
}

export function requireVerification(ledger, { name, command = '', description = '' } = {}) {
  const item = { id: id('verify'), name: String(name || '').trim(), command: String(command || ''), description: String(description || ''), status: 'pending' };
  if (!item.name) throw new Error('Verification requirement requires a name.');
  ledger.verification.required.push(item);
  ledger.verification.status = 'pending';
  touch(ledger);
  return item;
}

export function recordVerification(ledger, name, passed, result = null) {
  const item = ledger.verification.required.find((entry) => entry.name === name);
  if (!item) throw new Error('Unknown verification requirement: ' + name);
  item.status = passed ? 'passed' : 'failed';
  if (passed) ledger.verification.passed.push(item.id);
  else ledger.verification.failed.push(item.id);
  recordEvidence(ledger, { kind: 'test_result', summary: (passed ? 'Passed: ' : 'Failed: ') + name, data: result });
  updateVerificationStatus(ledger);
  touch(ledger);
}

function updateVerificationStatus(ledger) {
  const required = ledger.verification.required;
  if (!required.length) {
    ledger.verification.status = 'not_required';
    return;
  }
  if (ledger.verification.failed.length) ledger.verification.status = 'failed';
  else if (ledger.verification.passed.length === required.length) ledger.verification.status = 'passed';
  else ledger.verification.status = 'pending';
}

export function addBlocker(ledger, { reason, stepId = null, resolution = '' } = {}) {
  const blocker = { id: id('block'), reason: String(reason || '').trim(), stepId, resolution: String(resolution || ''), createdAt: now(), resolvedAt: null };
  if (!blocker.reason) throw new Error('Blocker requires a reason.');
  ledger.blockers.push(blocker);
  ledger.status = 'blocked';
  if (stepId) requireStep(ledger, stepId).status = 'blocked';
  touch(ledger);
  return blocker;
}

export function resolveBlocker(ledger, blockerId, resolution = '') {
  const blocker = ledger.blockers.find((entry) => entry.id === blockerId);
  if (!blocker) throw new Error('Unknown blocker: ' + blockerId);
  blocker.resolvedAt = now();
  if (resolution) blocker.resolution = resolution;
  if (!ledger.blockers.some((entry) => !entry.resolvedAt)) {
    ledger.status = ledger.steps.some((step) => step.status === 'in_progress') ? 'in_progress' : 'planning';
  }
  touch(ledger);
}

export function nextStep(ledger) {
  for (const step of ledger.steps) {
    if (step.status !== 'pending') continue;
    try {
      assertDependencies(ledger, step);
      return step;
    } catch {}
  }
  return null;
}

export function snapshotLedger(ledger) {
  return {
    id: ledger.id,
    goal: ledger.goal,
    status: ledger.status,
    context: ledger.context,
    steps: ledger.steps.map((step) => ({ ...step })),
    evidence: ledger.evidence.map((entry) => ({ ...entry })),
    blockers: ledger.blockers.map((entry) => ({ ...entry })),
    changedFiles: [...ledger.changedFiles],
    verification: {
      required: ledger.verification.required.map((entry) => ({ ...entry })),
      passed: [...ledger.verification.passed],
      failed: [...ledger.verification.failed],
      status: ledger.verification.status
    },
    createdAt: ledger.createdAt,
    updatedAt: ledger.updatedAt,
    version: ledger.version
  };
}

export function restoreLedger(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new TypeError('Ledger snapshot must be an object.');
  const ledger = createTaskLedger({ goal: snapshot.goal, context: snapshot.context });
  ledger.id = snapshot.id || ledger.id;
  ledger.status = snapshot.status || 'planning';
  ledger.steps = (snapshot.steps || []).map((step) => ({ ...step }));
  ledger.evidence = (snapshot.evidence || []).map((entry) => ({ ...entry }));
  ledger.blockers = (snapshot.blockers || []).map((entry) => ({ ...entry }));
  ledger.changedFiles = new Set(snapshot.changedFiles || []);
  ledger.verification = {
    required: (snapshot.verification && snapshot.verification.required || []).map((entry) => ({ ...entry })),
    passed: [...(snapshot.verification && snapshot.verification.passed || [])],
    failed: [...(snapshot.verification && snapshot.verification.failed || [])],
    status: snapshot.verification && snapshot.verification.status || 'pending'
  };
  ledger.createdAt = snapshot.createdAt || ledger.createdAt;
  ledger.updatedAt = snapshot.updatedAt || ledger.updatedAt;
  ledger.version = Number(snapshot.version) || 1;
  return ledger;
}

function requireStep(ledger, stepId) {
  const step = ledger.steps.find((entry) => entry.id === stepId);
  if (!step) throw new Error('Unknown task step: ' + stepId);
  return step;
}

function assertDependencies(ledger, step) {
  for (const dependencyId of step.dependsOn) {
    const dependency = requireStep(ledger, dependencyId);
    if (dependency.status !== 'done') throw new Error('Step ' + step.id + ' depends on incomplete step ' + dependencyId);
  }
}

function touch(ledger) {
  ledger.updatedAt = now();
  ledger.version += 1;
}
