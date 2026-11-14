import { createHash, randomUUID } from 'node:crypto';
import { normalizeAgentUsage } from './agent-tasks.mjs';
import { MAX_STEER_CHARS, foldSteering } from './steering.mjs';
import { mkdir, open, readdir, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { readBoundedRegularFile } from './safe-storage.mjs';
import { getConfigDirectory } from './config.mjs';
import { sanitizeSharedTaskStore } from './shared-tasks.mjs';
import { sanitizeMustPreserve } from './context.mjs';
import { redactSecrets } from './auto-memory.mjs';
import { atomicWriteFile, replaceFileDurably } from './atomic-write.mjs';
import { appendEvent, clearEvents } from './event-stream.mjs';
import { recoveredToolContent } from './tool-results.mjs';

// A saved session holds the whole live transcript, which the agent already
// keeps inside the model's context window by compacting. A long agentic turn
// is hundreds of messages, and a 1M-token window is several MiB of text, so
// these caps only stop runaway files; a session over the byte cap is saved
// with its oldest exchanges dropped rather than not saved at all.
export const MAX_SESSION_BYTES = 64 * 1024 * 1024;
// Message count is bounded by the byte cap; a count cap silently dropped the
// start of long sessions (a 2,500-tool-call session is 5,000 messages).
const MAX_MESSAGES = 1000000;
const MAX_TOOL_CALLS_PER_MESSAGE = 512;

export function workspaceSessionKey(root) {
  return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 20);
}

function validateId(id) {
  if (typeof id !== 'string' || !/^[a-f0-9-]{20,80}$/i.test(id)) throw new Error('Invalid session ID.');
  return id;
}

export function getSessionDirectory(root, env = process.env) {
  return path.join(getConfigDirectory(env), 'sessions', workspaceSessionKey(root));
}

function sessionPath(root, id, env = process.env) {
  return path.join(getSessionDirectory(root, env), validateId(id) + '.json');
}

function validateMessages(messages) {
  if (!Array.isArray(messages) || messages.length < 1 || messages.length > MAX_MESSAGES) throw new Error('Session history has an invalid message count.');
  for (const item of messages) {
    if (!item || typeof item !== 'object' || !['system', 'user', 'assistant', 'tool'].includes(item.role)) throw new Error('Session history contains an invalid message.');
    if (item.content !== undefined && item.content !== null && typeof item.content !== 'string') throw new Error('Session history contains non-text message content.');
    if (item.tool_calls !== undefined && (!Array.isArray(item.tool_calls) || item.tool_calls.length > MAX_TOOL_CALLS_PER_MESSAGE)) throw new Error('Session history contains invalid tool calls.');
    if (item.role === 'tool' && typeof item.tool_call_id !== 'string') throw new Error('Session history contains a tool result without an ID.');
  }
  if (messages[0].role !== 'system') throw new Error('Session history must begin with system context.');
  return messages;
}

function sanitizeTodos(value) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(['pending', 'in_progress', 'completed']);
  const todos = [];
  let hasInProgress = false;
  for (const item of value.slice(0, 50)) {
    if (!item || typeof item.content !== 'string' || !item.content.trim() || !allowed.has(item.status)) continue;
    let status = item.status;
    if (status === 'in_progress') {
      if (hasInProgress) status = 'pending';
      else hasInProgress = true;
    }
    todos.push({ content: item.content.trim().slice(0, 200), status });
  }
  return todos;
}

function sanitizeWorkflowCheckpoint(value) {
  if (!value || typeof value !== 'object' || value.active !== true) return null;
  const requestedParallel = Number(value.maxParallel);
  const maxParallel = Number.isInteger(requestedParallel) && requestedParallel >= 1 && requestedParallel <= 6 ? requestedParallel : 3;
  const teamId = typeof value.teamId === 'string' && /^team_[1-9]\d{0,5}$/.test(value.teamId) ? value.teamId : null;
  const savedAt = typeof value.savedAt === 'string' && Number.isFinite(Date.parse(value.savedAt)) ? value.savedAt : new Date(0).toISOString();
  return { active: true, maxParallel, teamId, savedAt };
}

const SESSION_AGENT_LIMIT = 32;
const SESSION_AGENT_STATUSES = new Set(['running', 'completed', 'failed', 'cancelled', 'interrupted']);

function safePersistedText(value, max) {
  return redactSecrets(String(value == null ? '' : value)).text.slice(0, max);
}

function safeWorktreePath(value) {
  const text = String(value || '').replace(/\\/g, '/').trim();
  if (!text || text.length > 240 || text.startsWith('/') || /^[A-Za-z]:/.test(text) ||
      text.split('/').some((segment) => segment === '..' || segment === '.')) return '';
  return text;
}

/** Persist agent summaries only; live child sessions, prompts, tools and process handles never survive. */
export function sanitizeAgentHistory(agentTasks) {
  const source = agentTasks && agentTasks.agents instanceof Map
    ? [...agentTasks.agents.values()]
    : Array.isArray(agentTasks) ? agentTasks : [];
  return source.slice(-SESSION_AGENT_LIMIT).flatMap((record) => {
    if (!record || typeof record !== 'object') return [];
    const id = String(record.id || '');
    if (!/^agent_[1-9]\d{0,8}$/.test(id)) return [];
    const status = SESSION_AGENT_STATUSES.has(record.status) ? record.status : 'interrupted';
    const worktree = record.worktree && typeof record.worktree === 'object' ? record.worktree : {};
    const worktreeInfo = record.worktreeInfo && typeof record.worktreeInfo === 'object' ? record.worktreeInfo : {};
    const branch = String(worktree.branch || worktreeInfo.branch || record.worktreeBranch || '').slice(0, 160);
    const relative = safeWorktreePath(worktree.relative || worktreeInfo.relative || record.worktreePath);
    const commitSha = String(worktree.commitSha || record.worktreeCommit || '').toLowerCase();
    const openWorktree = resumableWorktree(record);
    const recentTools = Array.isArray(record.recentTools)
      ? record.recentTools.slice(-10).map((name) => String(name || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 100)).filter(Boolean)
      : [];
    const snapshot = {
      id,
      parentId: record.parentId === 'main' || /^agent_[1-9]\d{0,8}$/.test(String(record.parentId || '')) ? String(record.parentId || 'main') : 'main',
      depth: Math.max(1, Math.min(32, Number.parseInt(record.depth, 10) || 1)),
      type: safePersistedText(record.type || 'general-purpose', 80),
      description: safePersistedText(record.description || '', 120),
      status,
      background: Boolean(record.background),
      startedAt: Number.isFinite(Number(record.startedAt)) ? Number(record.startedAt) : Date.now(),
      finishedAt: Number.isFinite(Number(record.finishedAt)) ? Number(record.finishedAt) : null,
      runs: Math.max(1, Math.min(1000, Number.parseInt(record.runs, 10) || 1)),
      toolCalls: Math.max(0, Math.min(100000, Number.parseInt(record.toolCalls, 10) || 0)),
      tokensUsed: Math.max(0, Math.min(1000000000, Number(record.tokensUsed) || 0)),
      ...(record.usage && record.usage.requests ? { usage: normalizeAgentUsage(record.usage) } : {}),
      recentTools,
      report: safePersistedText(record.report || '', 200000),
      error: safePersistedText(record.error || '', 1500),
      readOnly: Boolean(record.readOnly),
      workspaceIsolation: (record.worktreeInfo || record.worktree || record.workspaceIsolation === 'worktree') ? 'worktree' : 'shared',
      ...(record.teamId && /^team_[1-9]\d{0,5}$/.test(String(record.teamId)) ? { teamId: String(record.teamId) } : {}),
      ...(record.sharedTaskId && /^task_[1-9]\d{0,8}$/.test(String(record.sharedTaskId)) ? { sharedTaskId: String(record.sharedTaskId) } : {}),
      ...(branch ? { worktreeBranch: branch } : {}),
      ...(relative ? { worktreePath: relative } : {}),
      ...(worktree.changed === true || record.worktreeChanged === true ? { worktreeChanged: true } : {}),
      ...( /^[0-9a-f]{40}$/.test(commitSha) ? { worktreeCommit: commitSha } : {}),
      ...(openWorktree ? { worktreeBase: openWorktree.base } : {}),
      ...((record.transcriptSaved === true || record.transcript === true) && (openWorktree || (!branch && !(record.worktreeInfo || record.worktree) && record.workspaceIsolation !== 'worktree')) ? { transcript: true } : {})
    };
    return [snapshot];
  });
}

// A resumed subagent continues from this transcript; like the session file it
// only needs a runaway guard (it is trimmed from the oldest end to fit).
const MAX_TRANSCRIPT_BYTES = 16 * 1024 * 1024;

function resumableWorktree(record) {
  if (!record || typeof record !== 'object') return null;
  const info = record.worktreeInfo || (record.worktreeBase && !record.worktreeCommit && (record.status === 'running' || record.status === 'interrupted')
    ? { base: record.worktreeBase, relative: record.worktreePath, branch: record.worktreeBranch } : null);
  if (!info || typeof info !== 'object' || info.hook || record.worktree) return null;
  const base = String(info.base || '').toLowerCase();
  const relative = safeWorktreePath(info.relative);
  if (!/^[0-9a-f]{40}$/.test(base) || !relative.startsWith('.oasis/worktrees/') || !info.branch) return null;
  return { base, relative, branch: String(info.branch).slice(0, 160) };
}

export function agentTranscriptPath(root, sessionId, agentId, env = process.env) {
  if (!/^agent_[1-9]\d{0,8}$/.test(String(agentId || ''))) throw new Error('Invalid agent ID.');
  return path.join(getSessionDirectory(root, env), validateId(sessionId) + '.agents', agentId + '.json');
}

function transcriptMessages(messages) {
  const usable = (Array.isArray(messages) ? messages : []).filter((m) => m && m.role !== 'system').map((m) => (m.images ? (({ images, ...rest }) => rest)(m) : m));
  let list = usable.slice(-(MAX_MESSAGES - 1));
  while (list.length && list[0].role !== 'user') list = list.slice(1);
  return list;
}

function resumableRecord(record) {
  return record && record.child && Array.isArray(record.child.messages) && ((!record.worktreeInfo && !record.worktree) || resumableWorktree(record)) && record.status !== 'cancelled' && /^agent_[1-9]\d{0,8}$/.test(String(record.id || ''));
}

async function saveAgentTranscripts(session, id, env) {
  const registry = session.agentTasks;
  if (!registry || !(registry.agents instanceof Map)) return new Set();
  const saved = new Set();
  for (const record of [...registry.agents.values()].slice(-SESSION_AGENT_LIMIT)) {
    if (!resumableRecord(record)) { if (record && record.transcriptSaved) saved.add(record.id); continue; }
    let list = transcriptMessages(record.child.messages);
    if (!list.length) continue;
    const signature = list.length + ':' + JSON.stringify(list[list.length - 1]).length;
    if (record.transcriptSignature === signature) { saved.add(record.id); continue; }
    let body = '';
    for (;;) {
      try { validateMessages([{ role: 'system', content: '' }, ...list]); } catch { list = []; }
      body = JSON.stringify({ schemaVersion: 1, agentId: record.id, type: String(record.type || 'general-purpose').slice(0, 80), model: String(record.child.config && record.child.config.model || '').slice(0, 200), messages: list }) + '\n';
      if (!list.length || Buffer.byteLength(body, 'utf8') <= MAX_TRANSCRIPT_BYTES) break;
      list = list.slice(Math.max(1, Math.floor(list.length / 4)));
      while (list.length && list[0].role !== 'user') list = list.slice(1);
    }
    if (!list.length) continue;
    const file = agentTranscriptPath(session.root, id, record.id, env);
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await atomicWriteFile(file, body, { encoding: 'utf8', mode: 0o600 });
      record.transcriptSignature = signature;
      record.transcriptSaved = true;
      saved.add(record.id);
    } catch { /* a transcript is a convenience; never fail the session save for it */ }
  }
  return saved;
}

export function checkpointDirectory(root, sessionId, env = process.env) {
  return path.join(getSessionDirectory(root, env), validateId(sessionId) + '.checkpoints');
}

export async function loadAgentTranscript(root, sessionId, agentId, env = process.env) {
  const file = agentTranscriptPath(root, sessionId, agentId, env);
  const data = JSON.parse(await readBoundedRegularFile(file, MAX_TRANSCRIPT_BYTES + 4096, { label: 'Agent transcript', tooLargeMessage: 'Agent transcript is too large.' }));
  if (!data || data.agentId !== agentId || !Array.isArray(data.messages) || !data.messages.length) throw new Error('Agent transcript is invalid.');
  validateMessages([{ role: 'system', content: '' }, ...data.messages]);
  if (data.messages.some((m) => m.role === 'system')) throw new Error('Agent transcript is invalid.');
  return { type: String(data.type || ''), model: String(data.model || ''), messages: data.messages };
}

// A saved transcript must not end with a tool call that has no result, or the
// provider rejects the next request. When OASIS stops part-way through a batch
// (crash, closed terminal, restart), the calls that finished keep their real
// output (from session.pendingToolOutputs, filled as each call returns) and the
// rest are marked as interrupted, so after a restore the model knows which
// steps already ran instead of repeating writes, commits or deploys.
export const INTERRUPTED_TOOL_RESULT = 'Interrupted: OASIS stopped while this tool call was running, so it may have partly run or not run at all. Check the current state before retrying it.';
export function completeExchanges(messages, pendingOutputs = null) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue;
    const answered = new Set(list.slice(i + 1).filter((m) => m && m.role === 'tool').map((m) => m.tool_call_id));
    if (message.tool_calls.every((call) => call && answered.has(call.id))) return list;
    const calls = message.tool_calls.filter((call) => call && typeof call.id === 'string' && call.id);
    if (calls.length !== message.tool_calls.length) return list.slice(0, i);
    const ids = new Set(calls.map((call) => call.id));
    const out = list.slice(0, i + 1);
    for (let j = i + 1; j < list.length && list[j] && list[j].role === 'tool'; j++) if (ids.has(list[j].tool_call_id)) out.push(list[j]);
    for (const call of calls) {
      if (answered.has(call.id)) continue;
      const finished = pendingOutputs && typeof pendingOutputs.get === 'function' ? pendingOutputs.get(call.id) : null;
      const text = finished && typeof finished.content === 'string' ? finished.content : '';
      out.push({
        role: 'tool',
        tool_call_id: call.id,
        name: String(call.function && call.function.name || (finished && finished.name) || ''),
        content: text ? recoveredToolContent(text) : INTERRUPTED_TOOL_RESULT
      });
    }
    return out;
  }
  return list;
}

function boundedHistory(messages, limit = MAX_MESSAGES) {
  if (messages.length <= limit || !messages[0] || messages[0].role !== 'system') return messages.slice(-limit);
  const rest = messages.slice(1);
  let start = rest.length - (limit - 2);
  while (start < rest.length && rest[start].role === 'tool') start++;
  const tail = rest.slice(start);
  let anchor = [];
  if (!tail.length || tail[0].role !== 'user') {
    for (let i = start - 1; i >= 0; i--) {
      if (rest[i].role === 'user') { anchor = [rest[i]]; break; }
    }
  }
  return [messages[0], ...anchor, ...tail];
}

// A /goal survives a restart. One that was running when the session was saved
// comes back paused: nothing works on it until the user types /goal resume.
export function sanitizeGoal(goal) {
  if (!goal || typeof goal !== 'object' || typeof goal.condition !== 'string' || !goal.condition.trim()) return null;
  const turns = Math.max(0, Math.min(10000, Math.floor(Number(goal.turns) || 0)));
  return {
    condition: safePersistedText(goal.condition.trim(), 4000),
    active: false,
    paused: Boolean(goal.paused || goal.active) && !goal.achieved,
    achieved: Boolean(goal.achieved),
    turns,
    reason: typeof goal.reason === 'string' ? safePersistedText(goal.reason, 2000) : ''
  };
}

// updatedAt ('' when the file is missing or unreadable) and the archived flag
// of a saved session, read from the head of its file (both come before the
// messages).
async function savedHead(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, bytesRead).toString('utf8');
    const match = head.match(/"updatedAt":\s*"([^"]{1,64})"/);
    const messagesAt = head.search(/"messages":/);
    const archivedAt = head.search(/"archived":\s*true/);
    return { updatedAt: match ? match[1] : '', archived: archivedAt >= 0 && (messagesAt < 0 || archivedAt < messagesAt) };
  } catch { return { updatedAt: '', archived: false }; } finally { if (handle) await handle.close().catch(() => {}); }
}

export async function saveSession(session, options = {}) {
  if (!session || !Array.isArray(session.messages)) throw new Error('There is no active session to save.');
  const env = options.env || process.env;
  let id = session.sessionId && validateId(session.sessionId) || randomUUID();
  // Another process (a second terminal on the same session, the web UI) may
  // have saved this session since this one loaded or last saved it. Writing
  // over it would silently lose that conversation, so save this one as a new
  // session instead and say so; both stay resumable.
  let forkedFrom = '';
  if (session.sessionId && session.persistedUpdatedAt) {
    const onDisk = await savedHead(sessionPath(session.root, id, env));
    if (onDisk.updatedAt && onDisk.updatedAt !== session.persistedUpdatedAt) {
      forkedFrom = id;
      id = randomUUID();
    } else if (onDisk.updatedAt && typeof session.persistedArchived === 'boolean' && Boolean(session.archived) === session.persistedArchived) {
      // Archiving from the web UI or `oasis sessions archive` rewrites the file
      // in place; a live session that did not change the flag itself keeps
      // the one on disk instead of silently un-archiving it on the next save.
      session.archived = onDisk.archived;
    }
  }
  const complete = completeExchanges(session.messages, session.pendingToolOutputs).map((message) => message && message.images ? (({ images, ...rest }) => rest)(message) : message);
  let messages = validateMessages(boundedHistory(complete));
  await saveAgentTranscripts(session, id, env);
  const payload = {
    schemaVersion: 1,
    id,
    workspaceRoot: path.resolve(session.root),
    updatedAt: new Date().toISOString(),
    provider: {
      protocol: session.config && session.config.protocol || 'openai-compatible',
      baseURL: session.config && session.config.baseURL || '',
      model: session.config && session.config.model || ''
    },
    ...(session.sessionName ? { name: String(session.sessionName).slice(0, 120) } : {}),
    ...(session.archived === true ? { archived: true } : {}),
    messages,
    pendingSteering: Array.isArray(session.pendingSteering)
      ? foldSteering(session.pendingSteering.filter((note) => typeof note === 'string').map((note) => safePersistedText(note.trim(), MAX_STEER_CHARS)).filter(Boolean))
      : [],
    todos: sanitizeTodos(session.todos),
    sharedTasks: sanitizeSharedTaskStore(session.sharedTasks),
    mustPreserve: sanitizeMustPreserve(session.mustPreserve),
    ...(sanitizeGoal(session.goal) ? { goal: sanitizeGoal(session.goal) } : {}),
    agents: sanitizeAgentHistory(session.agentTasks),
    // A mid-turn snapshot marks the turn as unfinished; the end-of-turn save
    // drops the mark. A session restored with it tells the model its last
    // step may not have completed.
    ...(options.turnInProgress ? { turnInProgress: { request: safePersistedText(String(session.currentRequest || '').trim().slice(0, 2000), 2000), savedAt: new Date().toISOString() } } : {}),
    workflowCheckpoint: sanitizeWorkflowCheckpoint(
      session.agentTasks && session.agentTasks.autoDispatch && session.agentTasks.autoDispatch.enabled === true
        ? {
            active: true,
            maxParallel: session.agentTasks.autoDispatch.maxParallel,
            teamId: session.agentTasks.autoDispatch.teamId,
            savedAt: new Date().toISOString()
          }
        : session.agentTasks && session.agentTasks.autoDispatchCheckpoint
    )
  };
  let body = JSON.stringify(payload, null, 2) + '\n';
  // Indentation can be a third of a large session: drop it before any history.
  if (Buffer.byteLength(body, 'utf8') > MAX_SESSION_BYTES) body = JSON.stringify(payload) + '\n';
  // Still over the byte cap: keep the most recent exchanges that fit.
  while (Buffer.byteLength(body, 'utf8') > MAX_SESSION_BYTES && messages.length > 3) {
    messages = validateMessages(boundedHistory(complete, Math.max(3, Math.floor(messages.length / 2))));
    payload.messages = messages;
    body = JSON.stringify(payload) + '\n';
  }
  if (Buffer.byteLength(body, 'utf8') > MAX_SESSION_BYTES) throw new Error('Session is too large to save safely. Start a fresh session or disable persistence.');
  const directory = getSessionDirectory(session.root, env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = sessionPath(session.root, id, env);
  await replaceFileDurably(destination, body, { mode: 0o600 });
  session.sessionId = id;
  session.persistedUpdatedAt = payload.updatedAt;
  session.persistedArchived = payload.archived === true;
  if (forkedFrom) {
    (session.hookMessages ||= []).push('[session] Another OASIS process saved session ' + forkedFrom + ' while this one was open. To keep both conversations, this one was saved as a new session: ' + id + ' (resume it with oasis --resume ' + id + ').');
  }
  try {
    await appendEvent(session.root, id, { type: 'session_saved', at: payload.updatedAt, ...(forkedFrom ? { forkedFrom } : {}) }, { env });
  } catch { /* event log is a convenience; never fail the session save for it */ }
  if (session.checkpoints && options.checkpoints !== false) {
    try {
      const { saveCheckpoints, checkpointPersistenceEnabled } = await import('./checkpoints.mjs');
      if (checkpointPersistenceEnabled(env)) await saveCheckpoints(session, checkpointDirectory(session.root, id, env));
    } catch { /* checkpoints are a convenience; never fail the session save for them */ }
  }
  return { id, path: destination, updatedAt: payload.updatedAt, ...(forkedFrom ? { forkedFrom } : {}) };
}

export async function loadSession(root, id, options = {}) {
  const env = options.env || process.env;
  const file = sessionPath(root, id, env);
  const source = await readBoundedRegularFile(file, MAX_SESSION_BYTES, { label: 'Saved session', tooLargeMessage: 'Stored session is too large.' });
  let payload;
  try { payload = JSON.parse(source); } catch {
    // Left in place so it can be inspected or repaired by hand.
    throw Object.assign(new Error('Saved session ' + id + ' is damaged (its file is not valid JSON) and cannot be resumed. The file was left at ' + file + '.'), { code: 'OASIS_SESSION_DAMAGED' });
  }
  if (!payload || payload.schemaVersion !== 1 || payload.id !== id || path.resolve(payload.workspaceRoot || '') !== path.resolve(root)) {
    throw new Error('That saved session does not belong to this workspace or uses an unsupported format.');
  }
  return {
    id: validateId(payload.id),
    updatedAt: String(payload.updatedAt || ''),
    provider: payload.provider || {},
    name: typeof payload.name === 'string' ? payload.name.slice(0, 120) : '',
    archived: payload.archived === true,
    messages: validateMessages(payload.messages),
    pendingSteering: Array.isArray(payload.pendingSteering)
      ? foldSteering(payload.pendingSteering.filter((note) => typeof note === 'string').map((note) => safePersistedText(note.trim(), MAX_STEER_CHARS)).filter(Boolean))
      : [],
    todos: sanitizeTodos(payload.todos),
    sharedTasks: sanitizeSharedTaskStore(payload.sharedTasks),
    mustPreserve: sanitizeMustPreserve(payload.mustPreserve),
    goal: sanitizeGoal(payload.goal),
    agents: sanitizeAgentHistory(payload.agents),
    turnInProgress: payload.turnInProgress && typeof payload.turnInProgress === 'object'
      ? { request: safePersistedText(String(payload.turnInProgress.request || '').slice(0, 2000), 2000), savedAt: String(payload.turnInProgress.savedAt || '').slice(0, 40) }
      : null,
    workflowCheckpoint: sanitizeWorkflowCheckpoint(payload.workflowCheckpoint),
    checkpointsDir: checkpointDirectory(root, payload.id, env)
  };
}

export async function listSessions(root, options = {}) {
  const env = options.env || process.env;
  const directory = getSessionDirectory(root, env);
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const sessions = [];
  for (const entry of entries) {
    const name = entry.name;
    if (!entry.isFile() || !/^[a-f0-9-]{20,80}\.json$/i.test(name)) continue;
    try {
      const data = JSON.parse(await readBoundedRegularFile(path.join(directory, name), MAX_SESSION_BYTES, { label: 'Saved session', tooLargeMessage: 'Stored session is too large.' }));

      if (data && data.schemaVersion === 1 && path.resolve(data.workspaceRoot || '') === path.resolve(root)) {
        const firstUser = Array.isArray(data.messages) ? data.messages.find((item) => item && item.role === 'user' && typeof item.content === 'string') : null;
        const title = firstUser ? promptTitle(firstUser.content) : '';
        sessions.push({ id: data.id, updatedAt: data.updatedAt, model: data.provider && data.provider.model || '', messages: Array.isArray(data.messages) ? data.messages.length : 0, title: typeof data.name === 'string' && data.name ? data.name : title, ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}), ...(data.archived === true ? { archived: true } : {}) });
      }
    } catch { /* Ignore corrupt session files in listings. */ }
  }
  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

// Listings meant for picking a conversation to continue hide archived ones;
// an archived session can still be resumed by its ID.
export const unarchivedSessions = (list) => list.filter((item) => !item.archived);

// Archive or unarchive a saved session in place (atomic rewrite of the file).
// Archived sessions stay loadable; listings that care (App Server thread/list)
// hide them unless asked. Returns the updated listing fields.
export async function setSessionArchived(root, id, archived, options = {}) {
  const env = options.env || process.env;
  const target = sessionPath(root, id, env);
  const payload = JSON.parse(await readBoundedRegularFile(target, MAX_SESSION_BYTES, { label: 'Saved session', tooLargeMessage: 'Stored session is too large.' }));
  if (!payload || payload.schemaVersion !== 1 || payload.id !== id || path.resolve(payload.workspaceRoot || '') !== path.resolve(root)) throw new Error('That saved session does not belong to this workspace or uses an unsupported format.');
  delete payload.archived;
  // The flag goes before the messages, where saveSession reads it from the
  // head of the file (a live session must not un-archive it on its next save).
  const ordered = {};
  for (const [key, value] of Object.entries(payload)) {
    if (key === 'messages' && archived) ordered.archived = true;
    ordered[key] = value;
  }
  if (archived && !ordered.archived) ordered.archived = true;
  await replaceFileDurably(target, JSON.stringify(ordered, null, 2) + '\n', { mode: 0o600 });
  return { id, archived: Boolean(archived), updatedAt: String(payload.updatedAt || ''), name: typeof payload.name === 'string' ? payload.name : '' };
}

export async function deleteSession(root, id, options = {}) {
  const target = sessionPath(root, id, options.env || process.env);
  const data = await loadSession(root, id, options);
  await unlink(target);
  await rm(target.replace(/\.json$/, '.agents'), { recursive: true, force: true }).catch(() => {});
  await rm(target.replace(/\.json$/, '.checkpoints'), { recursive: true, force: true }).catch(() => {});
  await clearEvents(root, id, { env: options.env || process.env }).catch(() => {});
  return { id: data.id, deleted: true };
}

export async function staleSessions(root, days, options = {}) {
  const limit = Number(days);
  if (!Number.isFinite(limit) || limit < 1) throw new Error('Use a whole number of days (1 or more).');
  const cutoff = (options.now || Date.now()) - Math.floor(limit) * 86400000;
  return (await listSessions(root, options)).filter((item) => {
    const at = Date.parse(item.updatedAt);
    return Number.isFinite(at) && at < cutoff;
  });
}

export async function pruneSessions(root, days, options = {}) {
  const keep = new Set(options.keep || []);
  const removed = [];
  for (const item of await staleSessions(root, days, options)) {
    if (keep.has(item.id)) continue;
    try { await deleteSession(root, item.id, options); removed.push(item.id); } catch {}
  }
  return removed;
}

// Save the conversation while a turn is still running (at most every few
// seconds), so closing the terminal, a crash or a server restart mid-task
// keeps the work done so far resumable. Tool callbacks fire before the result
// joins the history, so the save trails the call by a moment (settleMs) and
// then captures the finished step. The end-of-turn save still runs and must
// call settleMidTurnSave first so an older snapshot never lands last.
export const MID_TURN_SAVE_MS = 3000;
const MID_TURN_SETTLE_MS = 200;
export function saveMidTurn(session, options = {}) {
  if (!session || session.midTurnTimer) return;
  const interval = Number.isFinite(options.intervalMs) ? options.intervalMs : MID_TURN_SAVE_MS;
  const settle = Number.isFinite(options.settleMs) ? options.settleMs : MID_TURN_SETTLE_MS;
  const wait = Math.max(settle, (session.midTurnSavedAt || 0) + interval - Date.now());
  session.midTurnTimer = setTimeout(() => {
    session.midTurnTimer = null;
    const previous = session.midTurnSave || Promise.resolve();
    session.midTurnSavedAt = Date.now();
    session.midTurnSave = previous.then(() => saveSession(session, { ...(options.env ? { env: options.env } : {}), turnInProgress: true })).catch(() => {});
  }, wait);
  session.midTurnTimer.unref?.();
}
export async function settleMidTurnSave(session) {
  if (!session) return;
  if (session.midTurnTimer) { clearTimeout(session.midTurnTimer); session.midTurnTimer = null; }
  if (session.midTurnSave) await session.midTurnSave;
}

// A chat's title from its first prompt: what the user typed, without the file
// contents an @mention attached ("Referenced files: <file path=...>") or
// Oasis's own tagged blocks (<system-reminder>, <file path="...">...</file>).
// Messages OASIS itself adds to the conversation as the user role: gate and
// guard nudges, hook feedback, compaction digests. History views, exports and
// the resume recap hide them, since the user never typed them. Keep in step
// with completion-gates.mjs, turn-guards.mjs, claim-check.mjs, auto-test.mjs,
// standing-corrections.mjs and agent.mjs (test/user-facing-prompt.test.mjs).
const OASIS_AUTHORED_PROMPT = /^(?:<system-reminder>|<oasis-|Before finalizing, complete the post-edit verification gate\.|Auto-test: Oasis ran the configured test command|Your reply (?:says|uses) |A [\w-]+ hook asked you to (?:continue|keep working)|Context digest of completed work in the current task|Summarize (?:this bounded transcript|these completed tool rounds))/;

export function isOasisAuthoredPrompt(content) {
  return OASIS_AUTHORED_PROMPT.test(String(content || '').trimStart());
}

// What the user typed: '' for an OASIS-authored message, otherwise the text
// without the reminder blocks and @file contents OASIS appended to it.
export function userFacingPrompt(content) {
  let text = String(content || '');
  if (isOasisAuthoredPrompt(text)) return '';
  const attached = text.indexOf('\n\nReferenced files:\n');
  if (attached >= 0) text = text.slice(0, attached);
  return text.replace(/<([a-z]+-[\w-]+|file|untrusted[\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function promptTitle(content, max = 80) {
  let text = String(content || '');
  const attached = text.indexOf('\n\nReferenced files:\n');
  if (attached >= 0) text = text.slice(0, attached);
  return text.replace(/<([a-z]+-[\w-]+|file|untrusted[\w-]*)(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => part && typeof part.text === 'string' ? part.text : '').join(' ');
  return '';
}

function fitLine(text, width) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  return flat.length > width ? flat.slice(0, Math.max(1, width - 1)) + '…' : flat;
}

// What /resume and oasis -c print straight away, so the user sees which
// conversation came back before typing: its title, age, and the last
// request and reply, each cut to one terminal row.
export function sessionRecap(saved, { width = 80, now = Date.now() } = {}) {
  if (!saved || !Array.isArray(saved.messages)) return '';
  const room = Math.max(20, Number(width) - 5);
  const users = saved.messages.filter((m) => m && m.role === 'user').map((m) => userFacingPrompt(messageText(m.content))).filter(Boolean);
  const replies = saved.messages.filter((m) => m && m.role === 'assistant').map((m) => messageText(m.content).trim()).filter(Boolean);
  const title = saved.name || users[0] || '(untitled)';
  const ms = now - Date.parse(saved.updatedAt || '');
  const age = !Number.isFinite(ms) ? '' : ms < 60_000 ? 'just now' : ms < 3_600_000 ? Math.round(ms / 60_000) + ' min ago' : ms < 86_400_000 ? Math.round(ms / 3_600_000) + ' h ago' : Math.round(ms / 86_400_000) + ' days ago';
  const lines = ['Resumed "' + fitLine(title, room - 20) + '" · ' + saved.messages.filter((m) => m && m.role !== 'system').length + ' messages' + (age ? ' · saved ' + age : '')];
  if (users.length) lines.push('  ❯ ' + fitLine(users[users.length - 1], room));
  if (replies.length) lines.push('  ● ' + fitLine(replies[replies.length - 1], room));
  return lines.join('\n') + '\n';
}
