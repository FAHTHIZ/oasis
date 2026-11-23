// Agent2Agent (A2A) protocol, https://a2a-protocol.org (Apache-2.0, Linux Foundation).
//
// Server: `oasis a2a serve` publishes an Agent Card at /.well-known/agent-card.json and
// answers JSON-RPC 2.0 over HTTP: SendMessage, SendStreamingMessage (SSE), GetTask,
// ListTasks, CancelTask and SubscribeToTask. Every A2A context is one OASIS session, so
// a remote agent can hold a multi-turn conversation. When OASIS needs an approval or
// asks a question, the task pauses in TASK_STATE_INPUT_REQUIRED and the next message
// on that task answers it.
//
// Client: remote A2A agents listed in the `a2aAgents` setting become the
// `remote_agent` tool, so an OASIS agent can delegate to agents built with other
// frameworks (LangGraph, Google ADK, CrewAI, Microsoft Agent Framework...).
//
// Both protocol versions in use are spoken: 1.0 (PascalCase methods, `{text}` parts,
// TASK_STATE_* enums) and 0.3 (`message/send`, `kind` discriminators, `completed`).
// Internally everything is 1.0; 0.3 is converted at the edge.
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual, createHash } from 'node:crypto';

export const A2A_PROTOCOL_VERSION = '1.0';
const SUPPORTED_VERSIONS = ['1.0', '0.3'];
const TERMINAL = new Set(['TASK_STATE_COMPLETED', 'TASK_STATE_FAILED', 'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED']);
const INTERRUPTED = new Set(['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_AUTH_REQUIRED']);
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_TASKS = 500;

export const A2A_ERRORS = Object.freeze({
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  taskNotFound: -32001,
  taskNotCancelable: -32002,
  pushNotSupported: -32003,
  unsupported: -32004,
  contentType: -32005,
  invalidAgentResponse: -32006,
  extendedCardNotConfigured: -32007,
  versionNotSupported: -32009
});

// ── Protocol objects: 1.0 inside, 0.3 at the edge ─────────────────────────────────────────

/** TASK_STATE_COMPLETED, 'completed' or 'input-required' → the 1.0 enum name. */
export function normalizeState(state) {
  const text = String(state || '').trim();
  if (!text) return 'TASK_STATE_UNSPECIFIED';
  if (text.startsWith('TASK_STATE_')) return text;
  return 'TASK_STATE_' + text.toUpperCase().replace(/-/g, '_').replace('CANCELLED', 'CANCELED');
}

export function stateTo03(state) {
  return normalizeState(state).slice('TASK_STATE_'.length).toLowerCase().replace(/_/g, '-');
}

function normalizeRole(role) {
  const text = String(role || '').toLowerCase();
  if (text === 'role_agent' || text === 'agent') return 'ROLE_AGENT';
  if (text === 'role_user' || text === 'user') return 'ROLE_USER';
  return 'ROLE_UNSPECIFIED';
}

/** Any 0.3 or 1.0 part → a 1.0 part. Unknown parts become null. */
export function normalizePart(part) {
  if (!part || typeof part !== 'object') return null;
  const extra = {};
  if (part.metadata && typeof part.metadata === 'object') extra.metadata = part.metadata;
  if (typeof part.text === 'string' && (part.kind === undefined || part.kind === 'text')) return { text: part.text, ...(part.mediaType ? { mediaType: part.mediaType } : {}), ...extra };
  if (part.kind === 'file' && part.file && typeof part.file === 'object') {
    const file = part.file;
    const meta = { ...(file.name ? { filename: String(file.name) } : {}), ...(file.mimeType ? { mediaType: String(file.mimeType) } : {}), ...extra };
    if (typeof file.bytes === 'string') return { raw: file.bytes, ...meta };
    if (typeof file.uri === 'string') return { url: file.uri, ...meta };
    return null;
  }
  if (part.kind === 'data' || (part.kind === undefined && 'data' in part)) return { data: part.data, mediaType: part.mediaType || 'application/json', ...extra };
  if (typeof part.raw === 'string') return { raw: part.raw, ...(part.filename ? { filename: part.filename } : {}), ...(part.mediaType ? { mediaType: part.mediaType } : {}), ...extra };
  if (typeof part.url === 'string') return { url: part.url, ...(part.filename ? { filename: part.filename } : {}), ...(part.mediaType ? { mediaType: part.mediaType } : {}), ...extra };
  return null;
}

function partTo03(part) {
  if (typeof part.text === 'string') return { kind: 'text', text: part.text, ...(part.metadata ? { metadata: part.metadata } : {}) };
  if ('data' in part) return { kind: 'data', data: part.data, ...(part.metadata ? { metadata: part.metadata } : {}) };
  const file = { ...(part.filename ? { name: part.filename } : {}), ...(part.mediaType ? { mimeType: part.mediaType } : {}) };
  if (typeof part.raw === 'string') file.bytes = part.raw;
  if (typeof part.url === 'string') file.uri = part.url;
  return { kind: 'file', file, ...(part.metadata ? { metadata: part.metadata } : {}) };
}

export function normalizeMessage(message) {
  if (!message || typeof message !== 'object') return null;
  const parts = (Array.isArray(message.parts) ? message.parts : []).map(normalizePart).filter(Boolean);
  return {
    messageId: String(message.messageId || randomUUID()),
    role: normalizeRole(message.role),
    parts,
    ...(message.contextId ? { contextId: String(message.contextId) } : {}),
    ...(message.taskId ? { taskId: String(message.taskId) } : {}),
    ...(message.metadata && typeof message.metadata === 'object' ? { metadata: message.metadata } : {}),
    ...(Array.isArray(message.referenceTaskIds) ? { referenceTaskIds: message.referenceTaskIds.map(String) } : {})
  };
}

function messageTo03(message) {
  return { kind: 'message', ...message, role: message.role === 'ROLE_AGENT' ? 'agent' : 'user', parts: message.parts.map(partTo03) };
}

export function normalizeTask(task) {
  if (!task || typeof task !== 'object' || !task.id) return null;
  const status = task.status || {};
  return {
    id: String(task.id),
    ...(task.contextId ? { contextId: String(task.contextId) } : {}),
    status: { state: normalizeState(status.state), ...(status.message ? { message: normalizeMessage(status.message) } : {}), ...(status.timestamp ? { timestamp: status.timestamp } : {}) },
    artifacts: (Array.isArray(task.artifacts) ? task.artifacts : []).map((artifact) => ({ ...artifact, parts: (artifact.parts || []).map(normalizePart).filter(Boolean) })),
    history: (Array.isArray(task.history) ? task.history : []).map(normalizeMessage).filter(Boolean),
    ...(task.metadata ? { metadata: task.metadata } : {})
  };
}

function taskTo03(task) {
  return {
    kind: 'task',
    id: task.id,
    contextId: task.contextId,
    status: { state: stateTo03(task.status.state), ...(task.status.message ? { message: messageTo03(task.status.message) } : {}), ...(task.status.timestamp ? { timestamp: task.status.timestamp } : {}) },
    ...(task.artifacts && task.artifacts.length ? { artifacts: task.artifacts.map((artifact) => ({ ...artifact, parts: artifact.parts.map(partTo03) })) } : {}),
    ...(task.history ? { history: task.history.map(messageTo03) } : {}),
    ...(task.metadata ? { metadata: task.metadata } : {})
  };
}

/** The text of a message or artifact's parts, with structured parts as JSON. */
export function partsText(parts = []) {
  return parts.map((part) => typeof part.text === 'string' ? part.text : 'data' in part ? JSON.stringify(part.data) : part.url ? '[file ' + (part.filename || part.url) + ']' : part.raw ? '[file ' + (part.filename || 'attachment') + ']' : '').filter(Boolean).join('\n');
}

const agentMessage = (text, task) => ({ messageId: randomUUID(), role: 'ROLE_AGENT', parts: [{ text }], ...(task ? { taskId: task.id, contextId: task.contextId } : {}) });

function rpcError(code, message, data) {
  const error = new Error(message);
  error.rpc = { code, message, ...(data ? { data } : {}) };
  return error;
}

// ── Agent card ───────────────────────────────────────────────────────────────────────────

/**
 * The Agent Card. A 1.0 client (A2A-Version: 1.0) gets the 1.0 card. Without the header
 * the card also carries the 0.3 fields (url, protocolVersion, preferredTransport), which
 * 1.0 parsers ignore, so older clients find the endpoint too.
 */
export function buildAgentCard({ url, name = 'OASIS', description, version = '', skills = [], auth = true, dialect = 'both' } = {}) {
  const card = {
    name,
    description: description || 'OASIS, a general-purpose autonomous agent: coding, research, data analysis, writing and computer tasks, with its own tools and subagents.',
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: A2A_PROTOCOL_VERSION }, { url, protocolBinding: 'JSONRPC', protocolVersion: '0.3' }],
    provider: { organization: 'OASIS', url: 'https://github.com/FAHTHIZ/oasis' },
    version: version || '0.0.0',
    documentationUrl: 'https://github.com/FAHTHIZ/oasis/blob/main/docs/A2A.md',
    capabilities: { streaming: true, pushNotifications: false, extendedAgentCard: false },
    defaultInputModes: ['text/plain', 'application/json'],
    defaultOutputModes: ['text/plain'],
    skills: skills.length ? skills : [{ id: 'oasis', name: 'OASIS agent', description: 'Any task OASIS can do in its workspace.', tags: ['general', 'coding', 'research'] }]
  };
  if (auth) {
    card.securitySchemes = { bearer: { httpAuthSecurityScheme: { scheme: 'Bearer', description: 'The token printed by oasis a2a serve, or OASIS_A2A_TOKEN.' } } };
    card.securityRequirements = [{ schemes: { bearer: { list: [] } } }];
  }
  if (dialect === '1.0') return card;
  // 0.3 fields.
  card.url = url;
  card.protocolVersion = '0.3.0';
  card.preferredTransport = 'JSONRPC';
  if (auth) {
    card.securitySchemes.bearer.type = 'http';
    card.securitySchemes.bearer.scheme = 'bearer';
    card.security = [{ bearer: [] }];
  }
  return card;
}

/** OASIS agent definitions → card skills (built-in and custom agents). */
export function agentSkills(agents = {}) {
  const skills = [{ id: 'oasis', name: 'OASIS agent', description: 'Any task OASIS can do in its workspace: coding, research, analysis, writing.', tags: ['general'] }];
  for (const [id, agent] of Object.entries(agents || {})) {
    if (!agent || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) continue;
    skills.push({ id, name: id, description: String(agent.description || id).slice(0, 300), tags: ['subagent'] });
    if (skills.length >= 32) break;
  }
  return skills;
}

// ── Server ───────────────────────────────────────────────────────────────────────────────

function bearerOk(header, token) {
  if (!token) return true;
  const match = /^Bearer\s+(.+)$/i.exec(String(header || ''));
  if (!match) return false;
  const a = createHash('sha256').update(match[1].trim()).digest();
  const b = createHash('sha256').update(token).digest();
  return timingSafeEqual(a, b);
}

export const isLoopbackHost = (host) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(host || '').toLowerCase());

/**
 * The A2A server core, independent of HTTP so it can be tested directly.
 * `startContext(contextId, { skill })` returns `{ run(text, hooks), close() }`; hooks are
 * `{ signal, onDelta(text), onTool(name), approval(message), askUser(question) }` and
 * run() resolves to `{ text }`.
 */
export function createA2aCore({ startContext, maxContexts = 32, contextIdleMs = 30 * 60_000 } = {}) {
  const tasks = new Map();
  const contexts = new Map();
  const listeners = new Map();

  const emit = (task, event) => {
    task.events.push(event);
    for (const listener of listeners.get(task.id) || []) listener(event);
  };
  const setStatus = (task, state, message = null) => {
    task.status = { state, ...(message ? { message } : {}), timestamp: new Date().toISOString() };
    if (message) task.history.push(message);
    emit(task, { statusUpdate: { taskId: task.id, contextId: task.contextId, status: task.status } });
  };
  const settled = (task) => TERMINAL.has(task.status.state) || INTERRUPTED.has(task.status.state);
  const waitSettled = (task) => settled(task) ? Promise.resolve() : new Promise((resolve) => {
    const listener = () => { if (settled(task)) { off(task.id, listener); resolve(); } };
    on(task.id, listener);
  });
  const on = (id, listener) => { const set = listeners.get(id) || new Set(); set.add(listener); listeners.set(id, set); };
  const off = (id, listener) => { const set = listeners.get(id); if (set) { set.delete(listener); if (!set.size) listeners.delete(id); } };

  async function context(contextId, skill) {
    let entry = contexts.get(contextId);
    if (entry) {
      if (entry.idleTimer) { clearTimeout(entry.idleTimer); entry.idleTimer = null; }
      return entry;
    }
    if (contexts.size >= maxContexts) {
      const idle = [...contexts.values()].filter((item) => !item.busy).sort((a, b) => a.usedAt - b.usedAt)[0];
      if (!idle) throw rpcError(A2A_ERRORS.unsupported, 'Too many conversations are running at once (' + maxContexts + '). Try again later.');
      closeContext(idle.id);
    }
    entry = { id: contextId, skill, busy: false, queue: Promise.resolve(), usedAt: Date.now(), idleTimer: null, agent: null };
    contexts.set(contextId, entry);
    try { entry.agent = await startContext(contextId, { skill }); }
    catch (error) { contexts.delete(contextId); throw rpcError(A2A_ERRORS.internal, 'Could not start an OASIS session: ' + error.message); }
    return entry;
  }

  function closeContext(id) {
    const entry = contexts.get(id);
    if (!entry) return;
    contexts.delete(id);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    Promise.resolve(entry.agent && entry.agent.close && entry.agent.close()).catch(() => {});
  }

  function remember(task) {
    tasks.set(task.id, task);
    if (tasks.size <= MAX_TASKS) return;
    for (const [id, old] of tasks) {
      if (tasks.size <= MAX_TASKS) break;
      if (TERMINAL.has(old.status.state)) { tasks.delete(id); listeners.delete(id); }
    }
  }

  // The running turn pauses here until the next message on the task answers.
  function askInput(task, text, kind) {
    return new Promise((resolve) => {
      task.pendingInput = { resolve, kind };
      setStatus(task, 'TASK_STATE_INPUT_REQUIRED', agentMessage(text, task));
    });
  }

  async function execute(task, entry, text) {
    const controller = new AbortController();
    task.controller = controller;
    let streamed = '';
    let started = false;
    const chunk = (value, last) => {
      emit(task, { artifactUpdate: { taskId: task.id, contextId: task.contextId, artifact: { artifactId: 'response', name: 'response', parts: [{ text: value }] }, append: started, lastChunk: last } });
      started = true;
    };
    setStatus(task, 'TASK_STATE_WORKING');
    try {
      const result = await entry.agent.run(text, {
        signal: controller.signal,
        onDelta: (value) => {
          const accumulated = String(value || '');
          if (!accumulated.startsWith(streamed)) return;
          const delta = accumulated.slice(streamed.length);
          if (!delta) return;
          streamed = accumulated;
          chunk(delta, false);
        },
        onTool: (name) => { if (!settled(task)) emit(task, { statusUpdate: { taskId: task.id, contextId: task.contextId, status: { state: 'TASK_STATE_WORKING', message: agentMessage('Using ' + name, task), timestamp: new Date().toISOString() } } }); },
        approval: async (message) => {
          if (controller.signal.aborted) return false;
          const { chatApprovalText } = await import('./approval-language.mjs');
          const answer = await askInput(task, chatApprovalText(message, {}, 4000) + '\n\nReply "yes" to allow it or "no" to refuse.', 'approval');
          return /^\s*(y|yes|allow|approve|approved|ok|okay|sure|go ahead)\b/i.test(answer);
        },
        askUser: async (question) => {
          const textQuestion = typeof question === 'string' ? question : question && (question.question || question.text) || JSON.stringify(question);
          return await askInput(task, String(textQuestion).slice(0, 4000), 'question');
        }
      });
      if (controller.signal.aborted || task.status.state === 'TASK_STATE_CANCELED') return;
      const finalText = String(result && result.text || '').trim() || '(no reply)';
      if (started && finalText.startsWith(streamed)) chunk(finalText.slice(streamed.length), true);
      else { started = false; chunk(finalText, true); }
      task.artifacts = [{ artifactId: 'response', name: 'response', parts: [{ text: finalText }] }];
      setStatus(task, 'TASK_STATE_COMPLETED', agentMessage(finalText, task));
    } catch (error) {
      if (task.status.state === 'TASK_STATE_CANCELED') return;
      setStatus(task, controller.signal.aborted ? 'TASK_STATE_CANCELED' : 'TASK_STATE_FAILED', agentMessage(controller.signal.aborted ? 'Canceled.' : 'OASIS failed: ' + String(error && error.message || error).slice(0, 2000), task));
    } finally {
      task.controller = null;
      task.pendingInput = null;
    }
  }

  /** SendMessage: start a task, or answer one that is waiting for input. */
  async function send(params = {}) {
    const message = normalizeMessage(params.message);
    if (!message || !message.parts.length) throw rpcError(A2A_ERRORS.invalidParams, 'params.message with at least one part is required.');
    const text = partsText(message.parts).trim();
    if (!text) throw rpcError(A2A_ERRORS.contentType, 'OASIS reads text and JSON parts; send the request as text.');
    if (message.taskId) {
      const task = tasks.get(message.taskId);
      if (!task) throw rpcError(A2A_ERRORS.taskNotFound, 'Task not found', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org', metadata: { taskId: message.taskId } }]);
      if (!task.pendingInput) throw rpcError(A2A_ERRORS.unsupported, 'Task ' + task.id + ' is ' + stateTo03(task.status.state) + ' and is not waiting for input. Send a new message in context ' + task.contextId + ' instead.');
      task.history.push({ ...message, contextId: task.contextId, taskId: task.id });
      const { resolve } = task.pendingInput;
      task.pendingInput = null;
      setStatus(task, 'TASK_STATE_WORKING');
      resolve(text);
      return task;
    }
    const contextId = message.contextId || randomUUID();
    const skill = String(params.metadata && (params.metadata.skill || params.metadata.agent) || message.metadata && (message.metadata.skill || message.metadata.agent) || '');
    const entry = await context(contextId, skill);
    const task = { id: randomUUID(), contextId, status: { state: 'TASK_STATE_SUBMITTED', timestamp: new Date().toISOString() }, artifacts: [], history: [{ ...message, contextId }], events: [], controller: null, pendingInput: null, createdAt: Date.now() };
    task.history[0].taskId = task.id;
    remember(task);
    emit(task, { task: publicTask(task) });
    // One turn at a time per conversation; later messages wait their turn.
    entry.queue = entry.queue.then(async () => {
      entry.busy = true;
      entry.usedAt = Date.now();
      try { if (task.status.state !== 'TASK_STATE_CANCELED') await execute(task, entry, text); }
      finally {
        entry.busy = false;
        entry.usedAt = Date.now();
        if (contexts.get(contextId) === entry && contextIdleMs > 0) {
          entry.idleTimer = setTimeout(() => closeContext(contextId), contextIdleMs);
          entry.idleTimer.unref?.();
        }
      }
    });
    return task;
  }

  function publicTask(task, historyLength) {
    const limit = Number.isInteger(historyLength) && historyLength >= 0 ? historyLength : null;
    const history = limit === null ? task.history : limit === 0 ? [] : task.history.slice(-limit);
    return { id: task.id, contextId: task.contextId, status: task.status, ...(task.artifacts.length ? { artifacts: task.artifacts } : {}), history };
  }

  function get(id) {
    const task = tasks.get(String(id || ''));
    if (!task) throw rpcError(A2A_ERRORS.taskNotFound, 'Task not found', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'TASK_NOT_FOUND', domain: 'a2a-protocol.org', metadata: { taskId: String(id || '') } }]);
    return task;
  }

  function cancel(id) {
    const task = get(id);
    if (TERMINAL.has(task.status.state)) {
      if (task.status.state === 'TASK_STATE_CANCELED') return task;
      throw rpcError(A2A_ERRORS.taskNotCancelable, 'Task ' + task.id + ' is already ' + stateTo03(task.status.state) + '.');
    }
    if (task.controller) task.controller.abort();
    if (task.pendingInput) { const { resolve, kind } = task.pendingInput; task.pendingInput = null; resolve(kind === 'approval' ? 'no' : ''); }
    setStatus(task, 'TASK_STATE_CANCELED', agentMessage('Canceled.', task));
    return task;
  }

  function list({ contextId, status, pageSize, pageToken } = {}) {
    const state = status ? normalizeState(status) : '';
    const all = [...tasks.values()].filter((task) => (!contextId || task.contextId === contextId) && (!state || task.status.state === state)).sort((a, b) => b.createdAt - a.createdAt);
    const size = Math.max(1, Math.min(100, Number(pageSize) || 50));
    const offset = Math.max(0, Number.parseInt(String(pageToken || '0'), 10) || 0);
    const page = all.slice(offset, offset + size);
    return { tasks: page.map((task) => publicTask(task, 0)), nextPageToken: offset + size < all.length ? String(offset + size) : '', pageSize: size, totalSize: all.length };
  }

  /** Writes a task's events (optionally replaying earlier ones) until it settles. */
  function subscribe(task, write, { replay = false } = {}) {
    return new Promise((resolve) => {
      if (replay) for (const event of task.events) write(event);
      if (settled(task)) { resolve(); return; }
      const listener = (event) => { write(event); if (settled(task)) { off(task.id, listener); resolve(); } };
      on(task.id, listener);
    });
  }

  function close() {
    for (const task of tasks.values()) if (!settled(task)) cancel(task.id);
    for (const id of [...contexts.keys()]) closeContext(id);
  }

  return { send, get, cancel, list, subscribe, waitSettled, publicTask, close, tasks, contexts, settled };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { reject(rpcError(A2A_ERRORS.invalidRequest, 'Request body is larger than 8 MB.')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const METHODS_03 = { 'message/send': 'SendMessage', 'message/stream': 'SendStreamingMessage', 'tasks/get': 'GetTask', 'tasks/list': 'ListTasks', 'tasks/cancel': 'CancelTask', 'tasks/resubscribe': 'SubscribeToTask', 'tasks/pushNotificationConfig/set': 'CreateTaskPushNotificationConfig', 'tasks/pushNotificationConfig/get': 'GetTaskPushNotificationConfig', 'tasks/pushNotificationConfig/list': 'ListTaskPushNotificationConfigs', 'tasks/pushNotificationConfig/delete': 'DeleteTaskPushNotificationConfig', 'agent/getAuthenticatedExtendedCard': 'GetExtendedAgentCard' };

/** One response object in the caller's dialect. */
function toDialect(dialect, kind, value) {
  if (dialect === '1.0') {
    if (kind === 'send') return value.role ? { message: value } : { task: value };
    return value;
  }
  if (kind === 'send' || kind === 'task') return value.role ? messageTo03(value) : taskTo03(value);
  if (kind === 'list') return { ...value, tasks: value.tasks.map(taskTo03) };
  return value;
}

function eventTo03(event, task) {
  if (event.task) return taskTo03(event.task);
  if (event.statusUpdate) {
    const update = event.statusUpdate;
    const state = normalizeState(update.status.state);
    return { kind: 'status-update', taskId: update.taskId, contextId: update.contextId, status: { state: stateTo03(state), ...(update.status.message ? { message: messageTo03(update.status.message) } : {}), timestamp: update.status.timestamp }, final: TERMINAL.has(state) || INTERRUPTED.has(state) };
  }
  if (event.artifactUpdate) {
    const update = event.artifactUpdate;
    return { kind: 'artifact-update', taskId: update.taskId, contextId: update.contextId, artifact: { ...update.artifact, parts: update.artifact.parts.map(partTo03) }, append: update.append, lastChunk: update.lastChunk };
  }
  return { kind: 'task', id: task.id };
}

/**
 * The HTTP server: GET /.well-known/agent-card.json, POST / for JSON-RPC.
 * Requests need `Authorization: Bearer <token>` unless the token is empty (loopback only).
 */
export function createA2aHttpServer({ core, card, token = '', log = () => {} }) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    const json = (status, body, headers = {}) => {
      if (res.headersSent) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && (url.pathname === '/.well-known/agent-card.json' || url.pathname === '/.well-known/agent.json')) {
      const asked = String(req.headers['a2a-version'] || '').trim();
      return json(200, card(asked === '1.0' ? '1.0' : 'both'));
    }
    if (req.method !== 'POST' || !['/', '/a2a', '/a2a/v1'].includes(url.pathname)) return json(404, { error: 'Not found. The Agent Card is at /.well-known/agent-card.json; JSON-RPC requests go to POST /.' });
    if (!bearerOk(req.headers.authorization, token)) {
      log('rejected a request without a valid token');
      return json(401, { jsonrpc: '2.0', id: null, error: { code: A2A_ERRORS.invalidRequest, message: 'Unauthorized: send Authorization: Bearer <token>.' } }, { 'www-authenticate': 'Bearer realm="oasis-a2a"' });
    }
    let id = null;
    try {
      const raw = await readBody(req);
      let request;
      try { request = JSON.parse(raw); } catch { throw rpcError(A2A_ERRORS.parse, 'Invalid JSON.'); }
      if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') throw rpcError(A2A_ERRORS.invalidRequest, 'Expected a JSON-RPC 2.0 request.');
      id = request.id ?? null;
      const legacy = METHODS_03[request.method];
      const method = legacy || request.method;
      const header = String(req.headers['a2a-version'] || '').trim();
      const version = header ? header.split('.').slice(0, 2).join('.') : legacy ? '0.3' : '1.0';
      if (!SUPPORTED_VERSIONS.includes(version)) throw rpcError(A2A_ERRORS.versionNotSupported, 'A2A version ' + header + ' is not supported; use 1.0 or 0.3.', [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'VERSION_NOT_SUPPORTED', domain: 'a2a-protocol.org', metadata: { supportedVersions: SUPPORTED_VERSIONS.join(',') } }]);
      const dialect = legacy ? '0.3' : version;
      const params = request.params && typeof request.params === 'object' ? request.params : {};
      const reply = (result) => json(200, { jsonrpc: '2.0', id, result });
      switch (method) {
        case 'SendMessage': {
          const task = await core.send(params);
          const configuration = params.configuration || {};
          // 1.0: returnImmediately (default false). 0.3: blocking (default true here, as in the reference SDK).
          const immediate = configuration.returnImmediately === true || configuration.blocking === false;
          if (!immediate) await core.waitSettled(task);
          return reply(toDialect(dialect, 'send', core.publicTask(task, configuration.historyLength)));
        }
        case 'SendStreamingMessage':
        case 'SubscribeToTask': {
          const task = method === 'SendStreamingMessage' ? await core.send(params) : core.get(params.id);
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          const write = (event) => {
            if (res.writableEnded) return;
            const result = dialect === '1.0' ? event : eventTo03(event, task);
            res.write('data: ' + JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n\n');
          };
          // A new task replays from its first event (the Task). An answer to an
          // input-required task, or a subscription, starts with the task as it is now.
          const replay = method === 'SendStreamingMessage' && !(params.message && params.message.taskId);
          if (!replay) write({ task: core.publicTask(task) });
          const closed = new Promise((resolve) => res.on('close', resolve));
          await Promise.race([core.subscribe(task, write, { replay }), closed]);
          if (!res.writableEnded) res.end();
          return;
        }
        case 'GetTask': return reply(toDialect(dialect, 'task', core.publicTask(core.get(params.id), params.historyLength)));
        case 'ListTasks': return reply(toDialect(dialect, 'list', core.list(params)));
        case 'CancelTask': return reply(toDialect(dialect, 'task', core.publicTask(core.cancel(params.id))));
        case 'CreateTaskPushNotificationConfig':
        case 'GetTaskPushNotificationConfig':
        case 'ListTaskPushNotificationConfigs':
        case 'DeleteTaskPushNotificationConfig':
          throw rpcError(A2A_ERRORS.pushNotSupported, 'Push notifications are not supported; use SendStreamingMessage or GetTask.');
        case 'GetExtendedAgentCard': throw rpcError(A2A_ERRORS.extendedCardNotConfigured, 'There is no extended Agent Card.');
        default: throw rpcError(A2A_ERRORS.methodNotFound, 'Unknown method ' + request.method + '.');
      }
    } catch (error) {
      const rpc = error.rpc || { code: A2A_ERRORS.internal, message: String(error && error.message || error) };
      if (res.headersSent) { if (!res.writableEnded) res.end(); return; }
      json(200, { jsonrpc: '2.0', id, error: rpc });
    }
  });
  return server;
}

/** A random bearer token for a server started without OASIS_A2A_TOKEN. */
export const newA2aToken = () => randomBytes(24).toString('base64url');

/**
 * `oasis a2a serve`: an OASIS session per A2A context, in `root`.
 * Returns { url, token, card, close }.
 */
export async function serveA2a({ root, env = process.env, host = '127.0.0.1', port = 41241, token = null, noAuth = false, publicUrl = '', permissionMode = null, version = '', log = () => {}, deps = {} } = {}) {
  if (noAuth && !isLoopbackHost(host)) throw new Error('--no-auth is only allowed on localhost. Anyone who can reach ' + host + ' could run OASIS.');
  const secret = noAuth ? '' : String(token || env.OASIS_A2A_TOKEN || '').trim() || newA2aToken();
  const agentModule = deps.agent || await import('./agent.mjs');
  const { loadConfig } = deps.config || await import('./config.mjs');
  const { loadAgentDefinitions } = deps.subagents || await import('./subagents.mjs');
  const config = await loadConfig({ env });
  if (!config.configured && !deps.startContext) throw new Error('No model provider is configured. Run `oasis setup` first, or set OASIS_PROTOCOL, OASIS_BASE_URL, OASIS_MODEL and the API key variable.');
  const agents = await loadAgentDefinitions(root, { env }).catch(() => ({}));
  const startContext = deps.startContext || (async (contextId, { skill }) => {
    const agent = skill && skill !== 'oasis' && agents[skill] ? skill : null;
    const session = await agentModule.createSession({ root, config, env, permissionMode, agent, sessionName: 'A2A ' + contextId.slice(0, 8) });
    session.headless = true;
    session.a2aContextId = contextId;
    return {
      run: (text, hooks) => agentModule.runAgentTurn(session, text, {
        env,
        signal: hooks.signal,
        onDelta: hooks.onDelta,
        onToolStart: ({ name }) => hooks.onTool(name),
        approval: (message) => hooks.approval(message),
        askUser: (question) => hooks.askUser(question)
      }),
      close: () => agentModule.closeSession(session)
    };
  });
  const core = createA2aCore({
    startContext,
    maxContexts: Math.max(1, Math.min(256, Number(env.OASIS_A2A_MAX_CONTEXTS) || 32)),
    contextIdleMs: env.OASIS_A2A_CONTEXT_IDLE_MS === undefined ? 30 * 60_000 : Math.max(0, Number(env.OASIS_A2A_CONTEXT_IDLE_MS) || 0)
  });
  const server = createA2aHttpServer({ core, token: secret, log, card: (dialect) => buildAgentCard({ url: endpoint, version, skills: agentSkills(agents), auth: Boolean(secret), dialect }) });
  let endpoint = '';
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const address = server.address();
  const shownHost = host.includes(':') && !host.startsWith('[') ? '[' + host + ']' : host;
  endpoint = publicUrl ? String(publicUrl).replace(/\/+$/, '') + '/' : 'http://' + shownHost + ':' + address.port + '/';
  return {
    url: endpoint,
    port: address.port,
    token: secret,
    core,
    close: async () => { core.close(); await new Promise((resolve) => server.close(() => resolve())); server.closeAllConnections?.(); }
  };
}

// ── Client ───────────────────────────────────────────────────────────────────────────────

async function fetchJson(fetchImpl, url, init, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  const outer = init.signal;
  const onAbort = () => controller.abort();
  if (outer) outer.addEventListener('abort', onAbort, { once: true });
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch {}
    return { status: response.status, body, text };
  } finally {
    clearTimeout(timer);
    if (outer) outer.removeEventListener('abort', onAbort);
  }
}

/** Fetches a remote Agent Card (from the card URL itself, the path, or the origin). */
export async function fetchAgentCard(base, { fetchImpl = globalThis.fetch, token = '', timeoutMs = 15_000, signal } = {}) {
  const target = new URL(base);
  const candidates = target.pathname.endsWith('.json') ? [target.href] : [
    new URL(target.pathname.replace(/\/+$/, '') + '/.well-known/agent-card.json', target.origin).href,
    new URL('/.well-known/agent-card.json', target.origin).href,
    new URL('/.well-known/agent.json', target.origin).href
  ];
  let lastError = '';
  for (const url of [...new Set(candidates)]) {
    const result = await fetchJson(fetchImpl, url, { headers: { accept: 'application/json', 'A2A-Version': A2A_PROTOCOL_VERSION, ...(token ? { authorization: 'Bearer ' + token } : {}) }, signal }, timeoutMs).catch((error) => ({ status: 0, body: null, text: error.message }));
    if (result.status === 200 && result.body && typeof result.body === 'object' && result.body.name) return result.body;
    lastError = result.status ? 'HTTP ' + result.status : result.text;
  }
  throw new Error('No A2A Agent Card at ' + base + ' (' + lastError + ').');
}

/** The JSON-RPC endpoint and protocol version to use from a card: 1.0 first, then 0.3. */
export function pickInterface(card, fallbackUrl = '') {
  const interfaces = [...(Array.isArray(card.supportedInterfaces) ? card.supportedInterfaces : []), ...(Array.isArray(card.additionalInterfaces) ? card.additionalInterfaces.map((item) => ({ url: item.url, protocolBinding: item.transport, protocolVersion: card.protocolVersion })) : [])]
    .filter((item) => item && item.url && String(item.protocolBinding || 'JSONRPC').toUpperCase() === 'JSONRPC');
  const major = (value) => String(value || '').split('.').slice(0, 2).join('.');
  const best = interfaces.find((item) => major(item.protocolVersion) === '1.0') || interfaces.find((item) => major(item.protocolVersion) === '0.3');
  if (best) return { url: best.url, version: major(best.protocolVersion) };
  if (card.url && (!card.preferredTransport || String(card.preferredTransport).toUpperCase() === 'JSONRPC')) return { url: card.url, version: '0.3' };
  if (fallbackUrl) return { url: fallbackUrl, version: '1.0' };
  throw new Error('The Agent Card for ' + (card.name || 'this agent') + ' offers no JSON-RPC interface (OASIS speaks A2A over JSON-RPC).');
}

/** A small A2A JSON-RPC client that speaks 1.0 or 0.3 and returns 1.0 objects. */
export class A2aClient {
  constructor({ url, version = '1.0', token = '', fetchImpl = globalThis.fetch, timeoutMs = 600_000 } = {}) {
    this.url = url;
    this.version = version === '0.3' ? '0.3' : '1.0';
    this.token = token;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
  }

  async call(method, params, { signal, timeoutMs } = {}) {
    const name = this.version === '0.3' ? Object.entries(METHODS_03).find(([, value]) => value === method)?.[0] || method : method;
    const result = await fetchJson(this.fetchImpl, this.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json', 'A2A-Version': this.version, ...(this.token ? { authorization: 'Bearer ' + this.token } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: this.nextId++, method: name, params }),
      signal
    }, timeoutMs || this.timeoutMs);
    if (result.status === 401 || result.status === 403) throw new Error('The remote agent refused the request (HTTP ' + result.status + '). Check its token.');
    if (!result.body || typeof result.body !== 'object') throw new Error('The remote agent sent no JSON-RPC reply (HTTP ' + result.status + ').');
    if (result.body.error) {
      const error = new Error('Remote agent error ' + result.body.error.code + ': ' + result.body.error.message);
      error.code = result.body.error.code;
      throw error;
    }
    return result.body.result;
  }

  /** The reply as { task } or { message }, both in 1.0 form. */
  static normalizeSendResult(result) {
    if (!result || typeof result !== 'object') throw new Error('The remote agent returned an empty result.');
    if (result.task) return { task: normalizeTask(result.task) };
    if (result.message) return { message: normalizeMessage(result.message) };
    if (result.kind === 'message' || (result.role && result.parts)) return { message: normalizeMessage(result) };
    if (result.id && result.status) return { task: normalizeTask(result) };
    throw new Error('The remote agent returned neither a task nor a message.');
  }

  async send(text, { contextId, taskId, metadata, signal, pollMs = 1500 } = {}) {
    const message = { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], ...(contextId ? { contextId } : {}), ...(taskId ? { taskId } : {}) };
    const wire = this.version === '0.3' ? messageTo03(message) : message;
    const params = { message: wire, configuration: this.version === '0.3' ? { blocking: true, acceptedOutputModes: ['text/plain', 'application/json'] } : { returnImmediately: false, acceptedOutputModes: ['text/plain', 'application/json'] }, ...(metadata ? { metadata } : {}) };
    const reply = A2aClient.normalizeSendResult(await this.call('SendMessage', params, { signal }));
    if (reply.message) return reply;
    // Servers that return early: poll until the task settles or the timeout passes.
    let task = reply.task;
    const deadline = Date.now() + this.timeoutMs;
    while (!TERMINAL.has(task.status.state) && !INTERRUPTED.has(task.status.state)) {
      if (signal && signal.aborted) throw new Error('Canceled.');
      if (Date.now() > deadline) return { task, timedOut: true };
      await new Promise((resolve) => { const timer = setTimeout(resolve, pollMs); timer.unref?.(); });
      task = normalizeTask(await this.call('GetTask', { id: task.id }, { signal }));
    }
    return { task };
  }

  async get(id, { signal } = {}) { return normalizeTask(await this.call('GetTask', { id }, { signal })); }
  async cancel(id, { signal } = {}) { return normalizeTask(await this.call('CancelTask', { id }, { signal })); }
}

/** a2aAgents settings (`{ name: "url" | { url, token, tokenEnv, description } }`) → entries. */
export function configuredA2aAgents(settings = {}, env = process.env) {
  const out = new Map();
  const raw = settings && settings.a2aAgents;
  const add = (name, value) => {
    const id = String(name || '').trim();
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(id)) return;
    const spec = typeof value === 'string' ? { url: value } : value && typeof value === 'object' ? value : null;
    if (!spec || typeof spec.url !== 'string') return;
    let url;
    try { url = new URL(spec.url); } catch { return; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    const token = typeof spec.token === 'string' ? spec.token : spec.tokenEnv ? String(env[spec.tokenEnv] || '') : String(env['OASIS_A2A_TOKEN_' + id.toUpperCase().replace(/[^A-Z0-9]/g, '_')] || '');
    out.set(id, { name: id, url: url.href, token, description: typeof spec.description === 'string' ? spec.description.slice(0, 300) : '' });
  };
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [name, value] of Object.entries(raw)) add(name, value);
  // OASIS_A2A_AGENTS="name=url,other=url" for one run.
  for (const item of String(env.OASIS_A2A_AGENTS || '').split(',')) {
    const at = item.indexOf('=');
    if (at > 0) add(item.slice(0, at).trim(), item.slice(at + 1).trim());
  }
  return out;
}

export function remoteAgentToolDefinition(agents) {
  const names = [...agents.keys()];
  const list = [...agents.values()].map((agent) => '- ' + agent.name + (agent.description ? ': ' + agent.description : '') + ' (' + new URL(agent.url).host + ')').join('\n');
  return { type: 'function', function: {
    name: 'remote_agent',
    description: 'Delegate to a remote agent over the A2A protocol. It runs on another system with its own tools and cannot see this conversation, so send a complete request. Reuse context_id for a follow-up in the same conversation. If it answers with state input-required, reply with task_id set. Remote agents:\n' + list,
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['send', 'status', 'cancel', 'card'], description: 'send (default), status of a task, cancel a task, or card to read its skills' },
      agent: { type: 'string', enum: names },
      message: { type: 'string', description: 'The request (send)' },
      context_id: { type: 'string', description: 'Continue this conversation' },
      task_id: { type: 'string', description: 'Answer a task that is waiting for input, or the task for status/cancel' }
    }, required: ['agent'] }
  } };
}

function taskReport(agent, task, timedOut = false) {
  const artifacts = (task.artifacts || []).map((artifact) => partsText(artifact.parts)).filter(Boolean).join('\n\n');
  const statusText = task.status.message ? partsText(task.status.message.parts) : '';
  const state = stateTo03(task.status.state);
  return {
    agent,
    state,
    task_id: task.id,
    ...(task.contextId ? { context_id: task.contextId } : {}),
    ...(artifacts ? { result: artifacts.slice(0, 100_000) } : {}),
    ...(statusText && statusText !== artifacts ? { message: statusText.slice(0, 20_000) } : {}),
    ...(state === 'input-required' ? { hint: 'The remote agent is waiting for an answer. Call remote_agent again with task_id ' + task.id + ' and your reply (ask the user first if it needs their decision).' } : {}),
    ...(timedOut ? { hint: 'Still running. Check later with action status and this task_id.' } : {})
  };
}

/** The remote_agent tool. Sending to an agent asks once per agent per session. */
export async function executeRemoteAgentTool(args = {}, context = {}, deps = {}) {
  const session = context.session || context;
  const env = context.env || process.env;
  const agents = session.a2aAgents instanceof Map ? session.a2aAgents : configuredA2aAgents(session.settings || {}, env);
  const agent = agents.get(String(args.agent || ''));
  if (!agent) return { error: 'Unknown remote agent ' + JSON.stringify(args.agent || '') + '. Configured: ' + ([...agents.keys()].join(', ') || 'none') + '.' };
  const action = String(args.action || 'send');
  const fetchImpl = deps.fetchImpl || globalThis.fetch;
  const approved = session.a2aApproved ||= new Set();
  if (!approved.has(agent.name) && !context.autoApprove && !context.ruleAllowed) {
    const ok = typeof context.approval === 'function' && await context.approval('Let OASIS talk to the remote agent "' + agent.name + '" at ' + new URL(agent.url).host + '? It sends requests (and whatever they contain) to that system for this session.', false, { tool: 'remote_agent', input: { agent: agent.name, action } });
    if (!ok) return { error: 'The user did not allow contacting the remote agent ' + agent.name + '.' };
    approved.add(agent.name);
  }
  const cache = session.a2aClients ||= new Map();
  let entry = cache.get(agent.name);
  try {
    if (!entry) {
      const card = await fetchAgentCard(agent.url, { fetchImpl, token: agent.token, signal: context.signal });
      const chosen = pickInterface(card, agent.url);
      entry = { card, client: new A2aClient({ url: chosen.url, version: chosen.version, token: agent.token, fetchImpl, timeoutMs: Math.max(10, Number(env.OASIS_A2A_TIMEOUT_SECONDS) || 600) * 1000 }) };
      cache.set(agent.name, entry);
    }
    if (action === 'card') {
      const { card } = entry;
      return { agent: agent.name, name: card.name, description: card.description, version: card.version, protocol: entry.client.version, streaming: Boolean(card.capabilities && card.capabilities.streaming), skills: (card.skills || []).slice(0, 40).map((skill) => ({ id: skill.id, name: skill.name, description: String(skill.description || '').slice(0, 300) })) };
    }
    if (action === 'status' || action === 'cancel') {
      if (!args.task_id) return { error: 'task_id is required for ' + action + '.' };
      const task = action === 'status' ? await entry.client.get(String(args.task_id), { signal: context.signal }) : await entry.client.cancel(String(args.task_id), { signal: context.signal });
      return taskReport(agent.name, task);
    }
    const text = String(args.message || '').trim();
    if (!text) return { error: 'message is required.' };
    const reply = await entry.client.send(text, { contextId: args.context_id ? String(args.context_id) : undefined, taskId: args.task_id ? String(args.task_id) : undefined, signal: context.signal });
    if (reply.message) return { agent: agent.name, state: 'completed', ...(reply.message.contextId ? { context_id: reply.message.contextId } : {}), result: partsText(reply.message.parts).slice(0, 100_000) };
    return taskReport(agent.name, reply.task, reply.timedOut);
  } catch (error) {
    cache.delete(agent.name);
    return { error: 'Remote agent ' + agent.name + ': ' + String(error && error.message || error) };
  }
}
