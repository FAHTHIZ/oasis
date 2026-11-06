import { createHash, randomUUID } from 'node:crypto';
import { normalizeAgentUsage } from './agent-tasks.mjs';
import { mkdir, readdir, rename, writeFile, chmod, unlink, rm } from 'node:fs/promises';
import path from 'node:path';
import { readBoundedRegularFile } from './safe-storage.mjs';
import { getConfigDirectory } from './config.mjs';
import { sanitizeSharedTaskStore } from './shared-tasks.mjs';
import { sanitizeMustPreserve } from './context.mjs';
import { redactSecrets } from './auto-memory.mjs';
import { atomicWriteFile } from './atomic-write.mjs';

const MAX_SESSION_BYTES = 3 * 1024 * 1024;
const MAX_MESSAGES = 120;

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
    if (item.tool_calls !== undefined && (!Array.isArray(item.tool_calls) || item.tool_calls.length > 30)) throw new Error('Session history contains invalid tool calls.');
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
    // Live records keep worktree facts in objects; saved snapshots (re-validated on load) keep them flat.
    const branch = String(worktree.branch || worktreeInfo.branch || record.worktreeBranch || '').slice(0, 160);
    const relative = safeWorktreePath(worktree.relative || worktreeInfo.relative || worktree.path || record.worktreePath);
    const commitSha = String(worktree.commitSha || record.worktreeCommit || '').toLowerCase();
    // A worktree worker that has not finished (no commit result yet) keeps its base
    // commit, so it can be resumed in the same checkout after a restart.
    const openWorktree = resumableWorktree(record);
    const recentTools = Array.isArray(record.recentTools)
      ? record.recentTools.slice(-10).map((name) => String(name || '').replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 100)).filter(Boolean)
      : [];
    const snapshot = {
      id,
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
      report: safePersistedText(record.report || '', 8000),
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

// Subagent transcripts (like Claude Code's subagents/*.jsonl): the conversation of
// each shared-workspace worker is saved next to the session, so after a restart
// send_message can resume the worker with its full context instead of starting
// over. Worktree workers are saved while they are still working in an OASIS-made
// git worktree (not a hook-made copy, and not yet committed): the checkout is
// re-verified before such a worker is resumed.
const MAX_TRANSCRIPT_BYTES = 1536 * 1024;

function resumableWorktree(record) {
  if (!record || typeof record !== 'object') return null;
  // A snapshot being re-validated on load carries the same facts as flat fields.
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
  // Start at a user message so a trimmed transcript never opens with an orphan tool result.
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

/**
 * Drop a trailing assistant tool-call message whose results have not all
 * arrived (and the partial results after it). Sessions are saved mid-turn, so
 * a crash or closed terminal must still leave a transcript every provider
 * accepts on resume.
 */
export function completeExchanges(messages) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const message = list[i];
    if (!message || message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) continue;
    const answered = new Set(list.slice(i + 1).filter((m) => m && m.role === 'tool').map((m) => m.tool_call_id));
    if (message.tool_calls.every((call) => call && answered.has(call.id))) return list;
    return list.slice(0, i);
  }
  return list;
}

/**
 * Keep the system context and the newest messages within MAX_MESSAGES. The
 * kept tail never opens with a tool result whose call was cut off, and when it
 * does not start at a user message, the user message it belongs to is kept
 * ahead of it. A plain slice dropped the system message once one long turn
 * passed the cap, so every later (mid-turn and final) save was rejected.
 */
function boundedHistory(messages) {
  if (messages.length <= MAX_MESSAGES || !messages[0] || messages[0].role !== 'system') return messages.slice(-MAX_MESSAGES);
  const rest = messages.slice(1);
  let start = rest.length - (MAX_MESSAGES - 2);
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

export async function saveSession(session, options = {}) {
  if (!session || !Array.isArray(session.messages)) throw new Error('There is no active session to save.');
  const env = options.env || process.env;
  const id = session.sessionId && validateId(session.sessionId) || randomUUID();
  // Image attachments are not saved; the text note in the tool result remains.
  const messages = validateMessages(boundedHistory(completeExchanges(session.messages)).map((message) => message && message.images ? (({ images, ...rest }) => rest)(message) : message));
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
    messages,
    pendingSteering: Array.isArray(session.pendingSteering)
      ? session.pendingSteering.filter((note) => typeof note === 'string').map((note) => safePersistedText(note.trim(), 20000)).filter(Boolean).slice(-20)
      : [],
    todos: sanitizeTodos(session.todos),
    sharedTasks: sanitizeSharedTaskStore(session.sharedTasks),
    mustPreserve: sanitizeMustPreserve(session.mustPreserve),
    agents: sanitizeAgentHistory(session.agentTasks),
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
  const body = JSON.stringify(payload, null, 2) + '\n';
  if (Buffer.byteLength(body, 'utf8') > MAX_SESSION_BYTES) throw new Error('Session is too large to save safely. Start a fresh session or disable persistence.');
  const directory = getSessionDirectory(session.root, env);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const destination = sessionPath(session.root, id, env);
  const temp = destination + '.' + randomUUID() + '.tmp';
  await writeFile(temp, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await rename(temp, destination);
    try { await chmod(destination, 0o600); } catch {}
  } catch (error) {
    try { await unlink(temp); } catch {}
    throw error;
  }
  session.sessionId = id;
  if (session.checkpoints && options.checkpoints !== false) {
    try {
      const { saveCheckpoints, checkpointPersistenceEnabled } = await import('./checkpoints.mjs');
      if (checkpointPersistenceEnabled(env)) await saveCheckpoints(session, checkpointDirectory(session.root, id, env));
    } catch { /* checkpoints are a convenience; never fail the session save for them */ }
  }
  return { id, path: destination, updatedAt: payload.updatedAt };
}

export async function loadSession(root, id, options = {}) {
  const env = options.env || process.env;
  const source = await readBoundedRegularFile(sessionPath(root, id, env), MAX_SESSION_BYTES, { label: 'Saved session', tooLargeMessage: 'Stored session is too large.' });
  const payload = JSON.parse(source);
  if (!payload || payload.schemaVersion !== 1 || payload.id !== id || path.resolve(payload.workspaceRoot || '') !== path.resolve(root)) {
    throw new Error('That saved session does not belong to this workspace or uses an unsupported format.');
  }
  return {
    id: validateId(payload.id),
    updatedAt: String(payload.updatedAt || ''),
    provider: payload.provider || {},
    name: typeof payload.name === 'string' ? payload.name.slice(0, 120) : '',
    messages: validateMessages(payload.messages),
    pendingSteering: Array.isArray(payload.pendingSteering)
      ? payload.pendingSteering.filter((note) => typeof note === 'string').map((note) => safePersistedText(note.trim(), 20000)).filter(Boolean).slice(-20)
      : [],
    todos: sanitizeTodos(payload.todos),
    sharedTasks: sanitizeSharedTaskStore(payload.sharedTasks),
    mustPreserve: sanitizeMustPreserve(payload.mustPreserve),
    agents: sanitizeAgentHistory(payload.agents),
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
        const title = firstUser ? firstUser.content.replace(/<[a-z-]+>[\s\S]*?<\/[a-z-]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80) : '';
        sessions.push({ id: data.id, updatedAt: data.updatedAt, model: data.provider && data.provider.model || '', messages: Array.isArray(data.messages) ? data.messages.length : 0, title: typeof data.name === 'string' && data.name ? data.name : title, ...(typeof data.name === 'string' && data.name ? { name: data.name } : {}) });
      }
    } catch { /* Ignore corrupt session files in listings. */ }
  }
  return sessions.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
}

export async function deleteSession(root, id, options = {}) {
  const target = sessionPath(root, id, options.env || process.env);
  const data = await loadSession(root, id, options);
  await unlink(target);
  await rm(target.replace(/\.json$/, '.agents'), { recursive: true, force: true }).catch(() => {});
  await rm(target.replace(/\.json$/, '.checkpoints'), { recursive: true, force: true }).catch(() => {});
  return { id: data.id, deleted: true };
}

/** Saved sessions for this workspace last updated more than `days` days ago (newest first). */
export async function staleSessions(root, days, options = {}) {
  const limit = Number(days);
  if (!Number.isFinite(limit) || limit < 1) throw new Error('Use a whole number of days (1 or more).');
  const cutoff = (options.now || Date.now()) - Math.floor(limit) * 86400000;
  return (await listSessions(root, options)).filter((item) => {
    const at = Date.parse(item.updatedAt);
    return Number.isFinite(at) && at < cutoff;
  });
}

/** Delete saved sessions older than `days`, skipping `keep` ids (e.g. the one being resumed). */
export async function pruneSessions(root, days, options = {}) {
  const keep = new Set(options.keep || []);
  const removed = [];
  for (const item of await staleSessions(root, days, options)) {
    if (keep.has(item.id)) continue;
    try { await deleteSession(root, item.id, options); removed.push(item.id); } catch {}
  }
  return removed;
}
