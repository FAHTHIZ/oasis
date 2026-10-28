// Dependency-aware task coordination shared by the main agent and its subagents.
// This is a session-local board, not a substitute for worktree isolation when agents edit code.
const MAX_TASKS = 100;
const MAX_DEPENDENCIES = 20;
const STATUSES = new Set(['pending', 'in_progress', 'completed']);
const TASK_ID = /^task_([1-9]\d{0,8})$/;
const DEFAULT_CLAIM_LEASE_SECONDS = 900;
const MIN_CLAIM_LEASE_SECONDS = 30;
const MAX_CLAIM_LEASE_SECONDS = 3600;

function cleanString(value, label, max, { required = false } = {}) {
  if (value === undefined || value === null) value = '';
  if (typeof value !== 'string') throw new Error(label + ' must be text.');
  const result = value.trim();
  if (required && !result) throw new Error(label + ' cannot be empty.');
  if (result.length > max) throw new Error(label + ' must be ' + max + ' characters or fewer.');
  return result;
}

function taskMap(store) {
  return new Map((store.tasks || []).map((task) => [task.id, task]));
}

function reaches(graph, start, target) {
  const seen = new Set();
  const stack = [start];
  while (stack.length) {
    const current = stack.pop();
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    for (const dependency of graph.get(current) || []) stack.push(dependency);
  }
  return false;
}

function normaliseDependencies(raw, store, taskId = '') {
  if (!Array.isArray(raw)) throw new Error('blocked_by must be an array of task IDs.');
  if (raw.length > MAX_DEPENDENCIES) throw new Error('A task can depend on at most ' + MAX_DEPENDENCIES + ' tasks.');
  const ids = [];
  for (const item of raw) {
    if (typeof item !== 'string' || !TASK_ID.test(item)) throw new Error('Every blocked_by entry must be a valid task ID such as task_1.');
    if (item === taskId) throw new Error('A task cannot depend on itself.');
    if (!store.tasks.some((task) => task.id === item)) throw new Error('Unknown dependency ' + item + '. Create that task first.');
    if (!ids.includes(item)) ids.push(item);
  }
  const graph = new Map(store.tasks.map((task) => [task.id, task.id === taskId ? ids : task.blockedBy]));
  for (const dependency of ids) {
    if (reaches(graph, dependency, taskId)) throw new Error('This dependency would create a task cycle.');
  }
  return ids;
}

export function sanitizeSharedTaskStore(value) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const raw = Array.isArray(input.tasks) ? input.tasks.slice(0, MAX_TASKS) : [];
  const ids = new Set();
  const tasks = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const id = typeof item.id === 'string' && TASK_ID.test(item.id) ? item.id : '';
    if (!id || ids.has(id)) continue;
    const subject = typeof item.subject === 'string' ? item.subject.trim().slice(0, 200) : '';
    if (!subject) continue;
    const status = STATUSES.has(item.status) ? item.status : 'pending';
    const description = typeof item.description === 'string' ? item.description.slice(0, 4000) : '';
    const owner = typeof item.owner === 'string' ? item.owner.slice(0, 100) : '';
    const createdBy = typeof item.createdBy === 'string' ? item.createdBy.slice(0, 100) : 'main';
    const timestamp = (candidate) => typeof candidate === 'string' && Number.isFinite(Date.parse(candidate)) ? candidate : new Date(0).toISOString();
    const blockedBy = Array.isArray(item.blockedBy) ? [...new Set(item.blockedBy.filter((dep) => typeof dep === 'string' && TASK_ID.test(dep)))].slice(0, MAX_DEPENDENCIES) : [];
    // A restored session has no live agent processes, so never restore a live lease.
    tasks.push({ id, subject, description, status, owner, blockedBy: blockedBy.filter((dep) => dep !== id), createdBy, createdAt: timestamp(item.createdAt), updatedAt: timestamp(item.updatedAt), claimedBy: '', claimExpiresAt: null });
    ids.add(id);
  }

  // Drop invalid dependency edges and any edge that would make the stored graph cyclic.
  const graph = new Map(tasks.map((task) => [task.id, []]));
  const validIds = new Set(tasks.map((task) => task.id));
  for (const task of tasks) {
    const safe = [];
    for (const dependency of task.blockedBy) {
      if (!validIds.has(dependency) || reaches(graph, dependency, task.id)) continue;
      graph.get(task.id).push(dependency);
      safe.push(dependency);
    }
    task.blockedBy = safe;
  }
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    // In-progress work cannot survive process restart: no subagent process survives with it.
    if (task.status === 'in_progress' || task.blockedBy.some((dep) => byId.get(dep)?.status !== 'completed')) {
      task.status = 'pending';
      task.claimedBy = '';
      task.claimExpiresAt = null;
    }
  }
  const maxId = tasks.reduce((max, task) => Math.max(max, Number(TASK_ID.exec(task.id)?.[1] || 0)), 0);
  const requestedNext = Number.isSafeInteger(input.nextId) && input.nextId > 0 ? input.nextId : 1;
  return { nextId: Math.max(requestedNext, maxId + 1), tasks };
}

export function createSharedTaskStore(value) {
  return sanitizeSharedTaskStore(value);
}

function ensureStore(session) {
  if (!session.sharedTasks || !Array.isArray(session.sharedTasks.tasks)) {
    session.sharedTasks = createSharedTaskStore(session.sharedTasks);
  }
  // Keep the same object identity: child sessions share this exact store with their parent.
  return session.sharedTasks;
}

function claimIsActive(task, nowMs = Date.now()) {
  return Boolean(task.claimedBy && task.claimExpiresAt && Date.parse(task.claimExpiresAt) > nowMs);
}

function taskView(task, store, actor = 'main', nowMs = Date.now()) {
  const byId = taskMap(store);
  const waitingOn = task.blockedBy.filter((id) => byId.get(id)?.status !== 'completed');
  const claimActive = claimIsActive(task, nowMs);
  return {
    id: task.id,
    subject: task.subject,
    description: task.description,
    status: task.status,
    owner: task.owner,
    claimed_by: task.claimedBy || null,
    claim_expires_at: task.claimExpiresAt || null,
    claim_expired: Boolean(task.claimedBy && task.claimExpiresAt && !claimActive),
    blocked_by: [...task.blockedBy],
    created_by: task.createdBy,
    created_at: task.createdAt,
    updated_at: task.updatedAt,
    ready: waitingOn.length === 0 && task.status !== 'completed' && (!claimActive || task.claimedBy === actor),
    waiting_on: waitingOn
  };
}

function getTask(store, idValue) {
  const id = cleanString(idValue, 'task_id', 32, { required: true });
  if (!TASK_ID.test(id)) throw new Error('task_id must look like task_1.');
  const task = store.tasks.find((item) => item.id === id);
  if (!task) throw new Error('Unknown task ' + id + '. Use task_list to see available tasks.');
  return task;
}

function dependsTransitivelyOn(task, target, byId, seen = new Set()) {
  if (seen.has(task.id)) return false;
  seen.add(task.id);
  for (const dependency of task.blockedBy) {
    if (dependency === target) return true;
    const next = byId.get(dependency);
    if (next && dependsTransitivelyOn(next, target, byId, seen)) return true;
  }
  return false;
}

export const SHARED_TASK_TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'task_create', description: 'Create a shared task on the main-session/subagent task board. Use blocked_by task IDs for prerequisites. Tasks remain pending until their dependencies are completed.', parameters: { type: 'object', properties: {
    subject: { type: 'string', description: 'Short action-oriented task title (required, max 200 characters)' },
    description: { type: 'string', description: 'Scope and acceptance criteria (max 4000 characters)' },
    owner: { type: 'string', description: 'Optional agent ID or human-readable owner' },
    blocked_by: { type: 'array', items: { type: 'string' }, description: 'Existing task IDs that must be completed first' }
  }, required: ['subject'] } } },
  { type: 'function', function: { name: 'task_list', description: 'List the shared task board with status, owner, dependencies and readiness. Filter by status or owner when needed.', parameters: { type: 'object', properties: {
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
    owner: { type: 'string', description: 'Filter by exact owner' },
    include_completed: { type: 'boolean', description: 'Defaults to true' }
  }, required: [] } } },
  { type: 'function', function: { name: 'task_get', description: 'Read a shared task and its direct dependents.', parameters: { type: 'object', properties: {
    task_id: { type: 'string', description: 'Task ID such as task_1' }
  }, required: ['task_id'] } } },
  { type: 'function', function: { name: 'task_claim', description: 'Atomically claim a ready shared task, or claim a specific task_id. A successful claim starts the task and gives you an exclusive time-limited lease. Renew it by claiming the same task again before it expires. Expired leases can be reclaimed; use task_release when abandoning work.', parameters: { type: 'object', properties: { task_id: { type: 'string', description: 'Optional specific task to claim; omit to claim the next ready task' }, lease_seconds: { type: 'integer', minimum: 30, maximum: 3600, description: 'Lease duration, 30–3600 seconds; defaults to 900 seconds' } }, required: [] } } },
  { type: 'function', function: { name: 'task_renew', description: 'Extend your own active task claim before it expires. Cannot renew another agent\'s claim or a lease that has already expired.', parameters: { type: 'object', properties: { task_id: { type: 'string', description: 'Task ID such as task_1' }, lease_seconds: { type: 'integer', description: 'New lease duration from 30 to 3600 seconds; defaults to 900' } }, required: ['task_id'] } } },
  { type: 'function', function: { name: 'task_release', description: 'Release a task claim when you cannot finish the work. An in-progress task returns to pending. Only the claimant can release an active lease; the main coordinator can force-release another agent\'s lease explicitly.', parameters: { type: 'object', properties: { task_id: { type: 'string' }, force: { type: 'boolean', description: 'Only the main coordinator may set true to force-release an active lease' } }, required: ['task_id'] } } },
  { type: 'function', function: { name: 'task_update', description: 'Update a shared task status, owner, description, title or dependencies. Tasks cannot start or complete before prerequisites; a prerequisite cannot be reopened while downstream work is active/completed.', parameters: { type: 'object', properties: {
    task_id: { type: 'string', description: 'Task ID such as task_1' },
    subject: { type: 'string', description: 'Replacement title (max 200 characters)' },
    description: { type: 'string', description: 'Replacement acceptance criteria (max 4000 characters)' },
    status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
    owner: { type: 'string', description: 'Replacement owner; empty text clears it' },
    blocked_by: { type: 'array', items: { type: 'string' }, description: 'Replacement list of prerequisite task IDs' }
  }, required: ['task_id'] } } }
];

export const SHARED_TASK_TOOL_NAMES = new Set(SHARED_TASK_TOOL_DEFINITIONS.map((tool) => tool.function.name));
export const SHARED_TASK_READ_ONLY_TOOL_NAMES = new Set(['task_list', 'task_get']);

export function runSharedTaskTool(session, name, args = {}) {
  const store = ensureStore(session);
  const actor = cleanString(session.agentId || 'main', 'actor', 100, { required: true });
  const nowMs = () => Date.now();
  const now = () => new Date().toISOString();
  if (name === 'task_create') {
    if (store.tasks.length >= MAX_TASKS) throw new Error('The shared task board is limited to ' + MAX_TASKS + ' tasks.');
    const subject = cleanString(args.subject, 'subject', 200, { required: true });
    const description = cleanString(args.description, 'description', 4000);
    const owner = cleanString(args.owner, 'owner', 100);
    const blockedBy = normaliseDependencies(args.blocked_by === undefined ? [] : args.blocked_by, store);
    const id = 'task_' + store.nextId++;
    const timestamp = now();
    const task = { id, subject, description, status: 'pending', owner, blockedBy, createdBy: cleanString(session.agentId || 'main', 'created_by', 100), createdAt: timestamp, updatedAt: timestamp };
    store.tasks.push(task);
    return { task: taskView(task, store), total: store.tasks.length, message: 'Created ' + id + (task.blockedBy.length ? ' with prerequisites.' : '. Assign or start it when ready.') };
  }

  if (name === 'task_claim') {
    const leaseSeconds = args.lease_seconds === undefined ? DEFAULT_CLAIM_LEASE_SECONDS : Number(args.lease_seconds);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < MIN_CLAIM_LEASE_SECONDS || leaseSeconds > MAX_CLAIM_LEASE_SECONDS) {
      throw new Error('lease_seconds must be an integer from ' + MIN_CLAIM_LEASE_SECONDS + ' to ' + MAX_CLAIM_LEASE_SECONDS + '.');
    }
    const at = nowMs();
    let task;
    if (args.task_id === undefined || args.task_id === null || String(args.task_id).trim() === '') {
      task = store.tasks.find((candidate) => taskView(candidate, store, actor, at).ready);
      if (!task) throw new Error('No ready, unclaimed shared task is available. Create a task or wait for prerequisites/leases to clear.');
    } else {
      task = getTask(store, args.task_id);
    }
    if (task.status === 'completed') throw new Error(task.id + ' is already completed and cannot be claimed.');
    const waitingOn = task.blockedBy.filter((id) => taskMap(store).get(id)?.status !== 'completed');
    if (waitingOn.length) throw new Error(task.id + ' is blocked by ' + waitingOn.join(', ') + '; complete those tasks first.');
    if (claimIsActive(task, at) && task.claimedBy !== actor) {
      throw new Error(task.id + ' is claimed by ' + task.claimedBy + ' until ' + task.claimExpiresAt + '.');
    }
    const reclaimedFrom = task.claimedBy && task.claimExpiresAt && Date.parse(task.claimExpiresAt) <= at && task.claimedBy !== actor
      ? task.claimedBy : null;
    task.claimedBy = actor;
    task.claimExpiresAt = new Date(at + leaseSeconds * 1000).toISOString();
    task.owner = actor;
    if (task.status === 'pending') task.status = 'in_progress';
    task.updatedAt = now();
    return {
      task: taskView(task, store, actor, at),
      lease_seconds: leaseSeconds,
      ...(reclaimedFrom ? { reclaimed_from: reclaimedFrom } : {}),
      message: reclaimedFrom
        ? 'Claimed ' + task.id + ' after the previous lease expired.'
        : 'Claimed ' + task.id + '. Renew before the lease expires, or use task_release if abandoning it.'
    };
  }

  if (name === 'task_renew') {
    const task = getTask(store, args.task_id);
    const leaseSeconds = args.lease_seconds === undefined ? DEFAULT_CLAIM_LEASE_SECONDS : Number(args.lease_seconds);
    if (!Number.isInteger(leaseSeconds) || leaseSeconds < MIN_CLAIM_LEASE_SECONDS || leaseSeconds > MAX_CLAIM_LEASE_SECONDS) {
      throw new Error('lease_seconds must be an integer from ' + MIN_CLAIM_LEASE_SECONDS + ' to ' + MAX_CLAIM_LEASE_SECONDS + '.');
    }
    const at = nowMs();
    if (!claimIsActive(task, at)) throw new Error(task.id + ' has no active claim to renew; claim it again if it is still available.');
    if (task.claimedBy !== actor) throw new Error(task.id + ' is claimed by ' + task.claimedBy + '; only that agent can renew this lease.');
    if (task.status === 'completed') throw new Error('Completed task ' + task.id + ' does not need a lease.');
    task.claimExpiresAt = new Date(at + leaseSeconds * 1000).toISOString();
    task.updatedAt = now();
    return { task: taskView(task, store, actor, at), lease_seconds: leaseSeconds, renewed: true, message: 'Renewed ' + task.id + ' for ' + leaseSeconds + ' seconds.' };
  }

  if (name === 'task_release') {
    const task = getTask(store, args.task_id);
    if (task.status === 'completed') throw new Error('Completed task ' + task.id + ' does not need releasing.');
    const at = nowMs();
    const active = claimIsActive(task, at);
    if (args.force === true && actor !== 'main') throw new Error('Only the main coordinator may force-release another agent\'s task claim.');
    if (active && task.claimedBy !== actor && args.force !== true) {
      throw new Error(task.id + ' is claimed by ' + task.claimedBy + '; only that agent or the main coordinator with force=true can release it.');
    }
    if (task.owner === task.claimedBy && task.claimedBy) task.owner = '';
    task.claimedBy = '';
    task.claimExpiresAt = null;
    if (task.status === 'in_progress') task.status = 'pending';
    task.updatedAt = now();
    return { task: taskView(task, store, actor, at), released: true, message: 'Released ' + task.id + (task.status === 'pending' ? '; it is available to claim again.' : '.') };
  }

  if (name === 'task_list') {
    if (args.status !== undefined && !STATUSES.has(args.status)) throw new Error('status must be pending, in_progress, or completed.');
    const owner = args.owner === undefined ? null : cleanString(args.owner, 'owner', 100);
    const includeCompleted = args.include_completed !== false;
    const tasks = store.tasks
      .filter((task) => args.status === undefined || task.status === args.status)
      .filter((task) => owner === null || task.owner === owner)
      .filter((task) => includeCompleted || task.status !== 'completed')
      .map((task) => taskView(task, store, actor));
    return { tasks, total: tasks.length, ready: tasks.filter((task) => task.ready).length, remaining: tasks.filter((task) => task.status !== 'completed').length };
  }

  if (name === 'task_get') {
    const task = getTask(store, args.task_id);
    const dependents = store.tasks.filter((item) => item.blockedBy.includes(task.id));
    return { task: taskView(task, store, actor), dependents: dependents.map((item) => taskView(item, store, actor)) };
  }

  if (name === 'task_update') {
    const task = getTask(store, args.task_id);
    const at = nowMs();
    const activeClaim = claimIsActive(task, at);
    if (activeClaim && task.claimedBy !== actor) {
      throw new Error(task.id + ' is claimed by ' + task.claimedBy + ' until ' + task.claimExpiresAt + '; update blocked to prevent conflicting work.');
    }
    const byId = taskMap(store);
    const next = { ...task, blockedBy: [...task.blockedBy] };
    if (Object.hasOwn(args, 'subject')) next.subject = cleanString(args.subject, 'subject', 200, { required: true });
    if (Object.hasOwn(args, 'description')) next.description = cleanString(args.description, 'description', 4000);
    if (Object.hasOwn(args, 'owner')) next.owner = cleanString(args.owner, 'owner', 100);
    if (Object.hasOwn(args, 'blocked_by')) next.blockedBy = normaliseDependencies(args.blocked_by, store, task.id);
    if (Object.hasOwn(args, 'status')) {
      if (!STATUSES.has(args.status)) throw new Error('status must be pending, in_progress, or completed.');
      next.status = args.status;
    }
    const waitingOn = next.blockedBy.filter((id) => byId.get(id)?.status !== 'completed');
    if ((next.status === 'in_progress' || next.status === 'completed') && waitingOn.length) {
      throw new Error(task.id + ' is blocked by ' + waitingOn.join(', ') + '; complete those tasks first.');
    }
    if ((next.status === 'in_progress' || next.status === 'completed') && (!activeClaim || task.claimedBy !== actor)) {
      throw new Error('Claim ' + task.id + ' with task_claim before starting or completing it. Claims expire; renew them before doing more work.');
    }
    if (task.status === 'completed' && next.status !== 'completed') {
      const activeDependents = store.tasks.filter((item) => item.id !== task.id && item.status !== 'pending' && dependsTransitivelyOn(item, task.id, byId));
      if (activeDependents.length) throw new Error('Cannot reopen ' + task.id + ' while dependent tasks are in progress or completed: ' + activeDependents.map((item) => item.id).join(', ') + '.');
    }
    Object.assign(task, next, { updatedAt: now() });
    if (next.status === 'completed' || (next.status === 'pending' && (!activeClaim || task.claimedBy === actor))) {
      task.claimedBy = '';
      task.claimExpiresAt = null;
    }
    return { task: taskView(task, store, actor), message: 'Updated ' + task.id + '.' };
  }

  throw new Error('Unknown shared task tool ' + name);
}
