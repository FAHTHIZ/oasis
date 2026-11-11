// Codex App Server compatible server: `oasis app-server` speaks the core of the
// Codex app-server v2 protocol (https://learn.chatgpt.com/docs/app-server) on
// stdin/stdout, so a client written for `codex app-server` can drive the OASIS
// runtime with any model OASIS supports. Messages are JSON-RPC 2.0, one per
// line; the "jsonrpc" field may be omitted, as in Codex.
//
// Implemented methods: initialize (+ initialized notification), thread/start,
// thread/resume, thread/fork, thread/read, thread/list, thread/name/set, turn/start,
// turn/steer, turn/interrupt, model/list.
// Notifications sent: thread/started, thread/status/changed, thread/name/updated,
// turn/started, turn/completed, turn/plan/updated, item/started, item/completed,
// item/agentMessage/delta, item/commandExecution/outputDelta (final output only),
// serverRequest/resolved.
// Server requests sent: item/commandExecution/requestApproval and
// item/fileChange/requestApproval (decisions accept, acceptForSession, decline,
// cancel). Everything else answers -32601 "Method not found".
//
// Field names and item shapes follow codex-rs/app-server-protocol (Apache-2.0);
// this is an independent implementation, no Codex code is included.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createTwoFilesPatch } from 'diff';

export const APP_SERVER_PLATFORM = { family: process.platform === 'win32' ? 'windows' : 'unix', os: process.platform === 'darwin' ? 'macos' : process.platform };

const EXECUTE_TOOLS = new Set(['run_command', 'run_shell', 'powershell', 'monitor_command', 'auto_test']);
const FILE_TOOLS = new Set(['edit_file', 'write_file', 'multi_edit', 'notebook_edit', 'delete_file', 'move_file', 'apply_patch']);
const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
const MAX_FILE = 1024 * 1024;

const nowSeconds = () => Math.floor(Date.now() / 1000);

function rpcError(code, message, data) {
  const error = new Error(message);
  error.rpc = { code, message, ...(data === undefined ? {} : { data }) };
  return error;
}

function quote(part) {
  const text = String(part);
  return /^[\w@%+=:,./-]+$/.test(text) ? text : "'" + text.replace(/'/g, "'\\''") + "'";
}

export function commandText(name, args = {}) {
  if (!args || typeof args !== 'object') return name;
  if (typeof args.command === 'string') return Array.isArray(args.args) && args.args.length ? [args.command, ...args.args].map(quote).join(' ') : args.command;
  if (Array.isArray(args.command)) return args.command.map(quote).join(' ');
  return name;
}

// Codex UserInput[] → prompt text plus image attachments.
export function inputToPrompt(input = [], root = process.cwd()) {
  const parts = [];
  const images = [];
  for (const item of Array.isArray(input) ? input : []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text' && typeof item.text === 'string') parts.push(item.text);
    else if (item.type === 'mention' && typeof item.path === 'string') parts.push('@' + item.path);
    else if (item.type === 'skill' && typeof item.name === 'string') parts.push('/' + item.name);
    else if (item.type === 'localImage' && typeof item.path === 'string') {
      const file = path.resolve(root, item.path);
      try {
        const info = statSync(file);
        if (info.isFile() && info.size <= 20 * MAX_FILE) {
          const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg');
          images.push({ mediaType: 'image/' + (ext || 'png'), data: readFileSync(file).toString('base64'), name: path.basename(file) });
        }
      } catch { parts.push('[image not readable: ' + item.path + ']'); }
    } else if (item.type === 'image' && typeof item.url === 'string') {
      const match = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(item.url);
      if (match) images.push({ mediaType: match[1], data: match[2] });
      else parts.push('[image: ' + item.url + ']');
    }
  }
  return { text: parts.join('\n\n').trim(), images };
}

// Codex sandbox / approvalPolicy → an OASIS permission mode. OASIS never turns
// approvals off through the protocol; "never" picks the risk-checked auto mode.
export function permissionModeFor({ sandbox, approvalPolicy } = {}, fallback = null) {
  if (sandbox === 'read-only') return 'plan';
  if (approvalPolicy === 'never') return 'auto';
  if (approvalPolicy === 'untrusted' || approvalPolicy === 'on-request' || approvalPolicy === 'on-failure') return 'default';
  return fallback;
}

function resultText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const pieces = [value.stdout, value.stderr, value.output, value.error, value.message].filter((piece) => typeof piece === 'string' && piece);
    if (pieces.length) return pieces.join('\n');
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}

function isFailure(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.error || value.ok === false || value.cancelled || value.timedOut) return true;
  return typeof value.exitCode === 'number' && value.exitCode !== 0;
}

function toolPaths(root, name, args = {}) {
  const list = [];
  for (const key of ['path', 'file', 'from', 'to', 'destination']) if (typeof args[key] === 'string') list.push(path.resolve(root, args[key]));
  if (name === 'apply_patch' && typeof args.patch === 'string') {
    for (const match of args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) list.push(path.resolve(root, match[1].trim()));
  }
  return [...new Set(list)];
}

function readSmall(file) {
  try { const info = statSync(file); return info.isFile() && info.size <= MAX_FILE ? readFileSync(file, 'utf8') : null; } catch { return null; }
}

export function createCodexAppServer(options = {}) {
  const env = options.env || process.env;
  const write = options.write || ((line) => process.stdout.write(line));
  const log = options.log || ((text) => process.stderr.write('[oasis app-server] ' + text + '\n'));
  const deps = options.deps || {};
  const threads = new Map();
  const pending = new Map();
  let initialized = false;
  let optOut = new Set();
  let nextRequestId = 0;
  let closed = false;

  const send = (message) => { if (!closed) write(JSON.stringify(message) + '\n'); };
  const notify = (method, params) => { if (!optOut.has(method)) send({ method, params }); };
  const request = (method, params) => new Promise((resolve, reject) => {
    if (closed) { reject(new Error('connection closed')); return; }
    const id = nextRequestId++;
    pending.set(id, { resolve, reject });
    send({ id, method, params });
  });

  async function load(name) {
    if (deps[name]) return deps[name];
    if (name === 'agent') return import('./agent.mjs');
    if (name === 'config') return import('./config.mjs');
    if (name === 'sessions') return import('./sessions.mjs');
    if (name === 'mentions') return import('./commands.mjs');
    throw new Error('unknown dependency ' + name);
  }

  async function workspace(cwd) {
    const root = typeof cwd === 'string' && cwd ? path.resolve(cwd) : (options.cwd || process.cwd());
    const info = await stat(root).catch(() => null);
    if (!info || !info.isDirectory()) throw rpcError(-32602, 'cwd is not a directory: ' + root);
    return root;
  }

  function threadStatus(entry) {
    if (!entry) return { type: 'notLoaded' };
    if (!entry.turn) return { type: 'idle' };
    return { type: 'active', activeFlags: entry.waiting ? ['waitingOnApproval'] : [] };
  }

  function turnView(turn, items = []) {
    return {
      id: turn.id, rootTurnId: turn.id, items, itemsView: items.length ? 'full' : 'notLoaded', status: turn.status, error: turn.error || null,
      startedAt: turn.startedAt, completedAt: turn.completedAt || null, durationMs: turn.completedAt ? Math.max(0, (turn.completedAt - turn.startedAt) * 1000) : null
    };
  }

  // Saved OASIS messages → Codex turns (one turn per user message).
  function historyTurns(messages = []) {
    const turns = [];
    let current = null;
    let n = 0;
    for (const message of messages) {
      if (!message || typeof message.content !== 'string' || !message.content) continue;
      if (message.role === 'user') {
        current = { id: 'turn-' + (++n), rootTurnId: null, items: [{ type: 'userMessage', id: 'item-' + n + '-u', clientId: null, content: [{ type: 'text', text: message.content, textElements: [] }] }], itemsView: 'full', status: 'completed', error: null, startedAt: null, completedAt: null, durationMs: null };
        current.rootTurnId = current.id;
        turns.push(current);
      } else if (message.role === 'assistant' && current) {
        current.items.push({ type: 'agentMessage', id: 'item-' + n + '-a' + current.items.length, text: message.content, phase: null, memoryCitation: null });
      }
    }
    return turns;
  }

  function threadView(entry, { id, root, preview = '', name = null, createdAt, updatedAt, model = null, turns = [] } = {}) {
    const session = entry && entry.session;
    const threadId = id || session.sessionId;
    return {
      id: threadId, sessionId: threadId, forkedFromId: (entry && entry.forkedFromId) || null, parentThreadId: null, preview, ephemeral: false, section: null, sectionEnteredAt: null, projectId: null,
      historyMode: 'standard', modelProvider: (entry && entry.config && entry.config.protocol) || 'oasis', model: model || (entry && entry.config && entry.config.model) || null, reasoningEffort: null,
      createdAt: createdAt || (entry && entry.createdAt) || nowSeconds(), updatedAt: updatedAt || nowSeconds(), recencyAt: null,
      status: threadStatus(entry), path: null, cwd: root || entry.root, cliVersion: options.version || '', originator: 'oasis', source: 'appServer',
      canAcceptDirectInput: true, threadSource: null, agentNickname: null, agentRole: null, gitInfo: null,
      name: name ?? (session && session.name) ?? null, daybreakEnabled: null, turns
    };
  }

  function preview(session) {
    const first = (session.messages || []).find((message) => message && message.role === 'user' && typeof message.content === 'string');
    return first ? first.content.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
  }

  async function openThread(params, restoreId = null, { fork = null } = {}) {
    const root = await workspace(params.cwd);
    const { createSession } = await load('agent');
    const { loadConfig } = await load('config');
    const config = await loadConfig({ env });
    if (!config.configured) throw rpcError(-32000, 'No model provider is configured. Run `oasis setup` in a terminal first, or set OASIS_PROTOCOL, OASIS_BASE_URL, OASIS_MODEL and the API key variable.');
    if (typeof params.model === 'string' && params.model) config.model = params.model;
    let restore = null;
    if (restoreId) {
      const { loadSession } = await load('sessions');
      restore = await loadSession(root, restoreId, { env }).catch((error) => { throw rpcError(-32002, 'Thread not found: ' + error.message); });
      if (fork) restore = { ...restore, id: null, name: '', messages: fork.trim(restore.messages), checkpointsDir: undefined };
    }
    const permissionMode = permissionModeFor(params, options.permissionMode || null);
    const session = await createSession({ root, config, restore, env, permissionMode });
    session.headless = true;
    session.appServer = true;
    if (!session.sessionId) {
      try { const { saveSession } = await load('sessions'); session.sessionId = (await saveSession(session, { env })).id; } catch { session.sessionId = randomUUID(); }
    }
    const entry = { session, root, config, turn: null, controller: null, waiting: false, createdAt: nowSeconds(), forkedFromId: fork ? restoreId : null };
    threads.set(session.sessionId, entry);
    return entry;
  }

  function threadEntry(threadId) {
    const entry = threads.get(threadId);
    if (!entry) throw rpcError(-32002, 'Thread ' + threadId + ' is not loaded. Call thread/start or thread/resume first.');
    return entry;
  }

  function threadResponse(entry, turns = []) {
    const thread = threadView(entry, { preview: preview(entry.session), turns });
    const mode = entry.session.permissions && entry.session.permissions.mode || 'default';
    return {
      thread, model: entry.config.model || '', modelProvider: entry.config.protocol || 'oasis', serviceTier: null, disabledPluginIds: [], cwd: entry.root, instructionSources: [],
      approvalPolicy: mode === 'auto' ? 'never' : 'on-request', approvalsReviewer: 'user',
      sandbox: mode === 'plan' ? { type: 'readOnly' } : { type: 'workspaceWrite', writableRoots: [entry.root], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
      reasoningEffort: null
    };
  }

  async function approve(entry, turn, items, message, meta = {}) {
    const name = meta && meta.tool || 'action';
    const input = meta && meta.input || {};
    const open = [...items.values()].reverse().find((item) => item.tool === name && !item.done);
    const itemId = open ? open.item.id : 'item-' + randomUUID();
    const isFile = FILE_TOOLS.has(name);
    const base = { threadId: entry.session.sessionId, turnId: turn.id, itemId, startedAtMs: Date.now(), reason: String(message || '').slice(0, 8000) };
    const method = isFile ? 'item/fileChange/requestApproval' : 'item/commandExecution/requestApproval';
    const params = isFile
      ? { ...base, grantRoot: null }
      : { ...base, kind: 'command', approvalId: null, environmentId: null, command: EXECUTE_TOOLS.has(name) ? commandText(name, input) : name + ' ' + JSON.stringify(input).slice(0, 2000), cwd: entry.root, commandActions: [], availableDecisions: meta && meta.suggestion ? ['accept', 'acceptForSession', 'decline', 'cancel'] : ['accept', 'decline', 'cancel'] };
    entry.waiting = true;
    notify('thread/status/changed', { threadId: entry.session.sessionId, status: threadStatus(entry) });
    const requestId = nextRequestId;
    let reply = null;
    try { reply = await request(method, params); } catch (error) { log('approval request failed: ' + error.message); }
    entry.waiting = false;
    notify('serverRequest/resolved', { threadId: entry.session.sessionId, requestId });
    notify('thread/status/changed', { threadId: entry.session.sessionId, status: threadStatus(entry) });
    const decision = reply && (typeof reply.decision === 'string' ? reply.decision : reply.decision && Object.keys(reply.decision)[0]);
    if (decision === 'cancel' && entry.controller) entry.controller.abort();
    if (open && (decision === 'decline' || decision === 'cancel')) open.declined = true;
    if (decision === 'acceptForSession') return meta && meta.suggestion ? 'always' : true;
    return decision === 'accept' || decision === 'acceptWithExecpolicyAmendment';
  }

  async function runTurn(entry, turn, text, images) {
    const threadId = entry.session.sessionId;
    const items = new Map();
    let message = null;
    let streamed = '';
    const startMessage = () => {
      if (message) return message;
      message = { type: 'agentMessage', id: 'item-' + randomUUID(), text: '', phase: null, memoryCitation: null };
      notify('item/started', { item: message, threadId, turnId: turn.id, startedAtMs: Date.now() });
      return message;
    };
    const finishMessage = (finalText) => {
      if (!message && !finalText) return;
      const item = startMessage();
      item.text = finalText || streamed;
      notify('item/completed', { item, threadId, turnId: turn.id, completedAtMs: Date.now() });
      message = null; streamed = '';
    };
    const { runAgentTurn, runAgentPlan } = await load('agent');
    const runner = entry.session.permissions && entry.session.permissions.mode === 'plan' && typeof runAgentPlan === 'function' ? runAgentPlan : runAgentTurn;
    try {
      const result = await runner(entry.session, text, {
        env,
        signal: entry.controller.signal,
        ...(images.length ? { images } : {}),
        onDelta: (accumulated) => {
          const value = String(accumulated || '');
          const delta = value.startsWith(streamed) ? value.slice(streamed.length) : value;
          streamed = value;
          if (!delta) return;
          const item = startMessage();
          notify('item/agentMessage/delta', { threadId, turnId: turn.id, itemId: item.id, delta });
        },
        onStreamRestart: () => { streamed = ''; },
        onText: (value) => finishMessage(String(value || '')),
        onToolStart: ({ name, args = {}, call, subagent }) => {
          if (message) finishMessage(streamed);
          const key = call && call.id ? String(call.id) : 'call-' + randomUUID();
          let item;
          const before = new Map();
          if (EXECUTE_TOOLS.has(name)) {
            item = { type: 'commandExecution', id: key, pluginId: null, scriptPath: null, command: commandText(name, args), cwd: typeof args.cwd === 'string' ? path.resolve(entry.root, args.cwd) : entry.root, processId: null, source: subagent ? 'subAgent' : 'agent', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
          } else if (FILE_TOOLS.has(name)) {
            for (const file of toolPaths(entry.root, name, args)) before.set(file, readSmall(file));
            item = { type: 'fileChange', id: key, changes: [...before.keys()].map((file) => ({ path: file, kind: { type: before.get(file) === null ? 'add' : 'update', movePath: null }, diff: '' })), status: 'inProgress' };
          } else if (/^mcp__/.test(name)) {
            const [, server = '', tool = name] = name.split('__');
            item = { type: 'mcpToolCall', id: key, server, tool, status: 'inProgress', arguments: args, appContext: null, mcpAppUi: null, pluginId: null, readOnlyHint: null, result: null, error: null, durationMs: null };
          } else {
            item = { type: 'dynamicToolCall', id: key, namespace: subagent ? 'subagent:' + subagent : null, tool: name, arguments: args, status: 'inProgress', contentItems: null, success: null, durationMs: null };
          }
          items.set(key, { tool: name, item, before, started: Date.now(), done: false });
          notify('item/started', { item, threadId, turnId: turn.id, startedAtMs: Date.now() });
          if (name === 'todo_write' && Array.isArray(args.todos)) {
            notify('turn/plan/updated', { threadId, turnId: turn.id, explanation: null, plan: args.todos.slice(0, 50).map((todo) => ({ step: String(todo.content || todo.activeForm || ''), status: todo.status === 'in_progress' ? 'inProgress' : todo.status === 'completed' ? 'completed' : 'pending' })) });
          }
        },
        onToolResult: ({ name, result, call }) => {
          const key = call && call.id ? String(call.id) : [...items.keys()].reverse().find((id) => items.get(id).tool === name && !items.get(id).done);
          const record = key && items.get(key);
          if (!record) return;
          record.done = true;
          const { item } = record;
          const failed = isFailure(result);
          const durationMs = Date.now() - record.started;
          if (item.type === 'commandExecution') {
            item.status = record.declined ? 'declined' : failed ? 'failed' : 'completed';
            item.aggregatedOutput = resultText(result).slice(-100_000);
            item.exitCode = result && typeof result.exitCode === 'number' ? result.exitCode : null;
            item.durationMs = durationMs;
            if (item.aggregatedOutput) notify('item/commandExecution/outputDelta', { threadId, turnId: turn.id, itemId: item.id, delta: item.aggregatedOutput });
          } else if (item.type === 'fileChange') {
            item.status = record.declined ? 'declined' : failed ? 'failed' : 'completed';
            item.changes = [...record.before.entries()].map(([file, oldText]) => {
              const newText = readSmall(file);
              const rel = path.relative(entry.root, file) || file;
              const kind = oldText === null && newText !== null ? 'add' : oldText !== null && newText === null ? 'delete' : 'update';
              const diff = oldText === newText ? '' : createTwoFilesPatch('a/' + rel, 'b/' + rel, oldText || '', newText || '', '', '', { context: 3 });
              return { path: file, kind: { type: kind, movePath: null }, diff };
            });
          } else if (item.type === 'mcpToolCall') {
            item.status = failed ? 'failed' : 'completed';
            item.durationMs = durationMs;
            if (failed) item.error = { message: resultText(result).slice(0, 20000) };
            else item.result = { content: [{ type: 'text', text: resultText(result).slice(0, 100_000) }], structuredContent: null };
          } else {
            item.status = failed ? 'failed' : 'completed';
            item.success = !failed;
            item.durationMs = durationMs;
            item.contentItems = [{ type: 'inputText', text: resultText(result).slice(0, 100_000) }];
          }
          notify('item/completed', { item, threadId, turnId: turn.id, completedAtMs: Date.now() });
        },
        approval: (text, _force = false, meta = {}) => approve(entry, turn, items, text, meta)
      });
      finishMessage(message ? streamed : '');
      turn.status = entry.controller.signal.aborted ? 'interrupted' : 'completed';
      if (result && result.limitReached) turn.error = { message: 'Stopped at the tool-call limit for one turn.', codexErrorInfo: null, additionalDetails: null };
    } catch (error) {
      finishMessage(message ? streamed : '');
      turn.status = entry.controller.signal.aborted ? 'interrupted' : 'failed';
      if (turn.status === 'failed') turn.error = { message: String(error && error.message || error), codexErrorInfo: null, additionalDetails: null };
    } finally {
      try { const { saveSession } = await load('sessions'); await saveSession(entry.session, { env }); } catch {}
      turn.completedAt = nowSeconds();
      entry.turn = null; entry.controller = null;
      notify('turn/completed', { threadId, turn: turnView(turn) });
      notify('thread/status/changed', { threadId, status: threadStatus(entry) });
    }
  }

  async function expand(entry, input) {
    const built = inputToPrompt(input, entry.root);
    let { text, images } = built;
    try {
      const { expandFileMentions } = await load('mentions');
      if (typeof expandFileMentions === 'function') {
        const expanded = await expandFileMentions(entry.root, text, { images: true });
        text = expanded.text; if (expanded.images && expanded.images.length) images = images.concat(expanded.images);
      }
    } catch {}
    return { text, images };
  }

  async function handle(method, params = {}) {
    if (method === 'initialize') {
      if (initialized) throw rpcError(-32600, 'Already initialized');
      initialized = true;
      const caps = params && params.capabilities || {};
      optOut = new Set(Array.isArray(caps.optOutNotificationMethods) ? caps.optOutNotificationMethods.filter((name) => typeof name === 'string') : []);
      const client = params && params.clientInfo && params.clientInfo.name ? String(params.clientInfo.name).slice(0, 80) : 'client';
      return { userAgent: 'oasis/' + (options.version || '0') + ' (' + client + ')', codexHome: env.OASIS_CONFIG_DIR || path.join(env.HOME || env.USERPROFILE || '', '.oasis'), platformFamily: APP_SERVER_PLATFORM.family, platformOs: APP_SERVER_PLATFORM.os };
    }
    if (!initialized) throw rpcError(-32600, 'Not initialized');
    switch (method) {
      case 'thread/start': {
        const entry = await openThread(params);
        const response = threadResponse(entry);
        notify('thread/started', { thread: response.thread });
        return response;
      }
      case 'thread/resume': {
        if (typeof params.threadId !== 'string' || !params.threadId) throw rpcError(-32602, 'threadId is required.');
        const loaded = threads.get(params.threadId);
        const entry = loaded || await openThread(params, params.threadId);
        return threadResponse(entry, historyTurns(entry.session.messages));
      }
      case 'thread/fork': {
        if (typeof params.threadId !== 'string' || !params.threadId) throw rpcError(-32602, 'threadId is required.');
        const source = threads.get(params.threadId);
        if (source && source.turn) throw rpcError(-32000, 'Wait for the running turn to finish (or interrupt it) before forking.');
        if (source) { try { const { saveSession } = await load('sessions'); await saveSession(source.session, { env }); } catch {} }
        // lastTurnId uses the turn ids from thread/resume and thread/read ("turn-N"): keep turns 1..N.
        const match = typeof params.lastTurnId === 'string' ? /^turn-(\d+)$/.exec(params.lastTurnId) : null;
        if (params.lastTurnId && !match) throw rpcError(-32602, 'lastTurnId must be a turn id from thread/read or thread/resume (turn-N).');
        const keep = match ? Number(match[1]) : Infinity;
        const trim = (messages = []) => {
          let users = 0;
          const index = messages.findIndex((message) => message && message.role === 'user' && typeof message.content === 'string' && message.content && ++users > keep);
          return index < 0 ? messages : messages.slice(0, index);
        };
        const entry = await openThread({ ...params, cwd: params.cwd || (source && source.root) }, params.threadId, { fork: { trim } });
        const response = threadResponse(entry, historyTurns(entry.session.messages));
        notify('thread/started', { thread: response.thread });
        return response;
      }
      case 'thread/read': {
        if (typeof params.threadId !== 'string' || !params.threadId) throw rpcError(-32602, 'threadId is required.');
        const loaded = threads.get(params.threadId);
        if (loaded) return { thread: threadView(loaded, { preview: preview(loaded.session), turns: params.includeTurns ? historyTurns(loaded.session.messages) : [] }) };
        const root = await workspace(params.cwd);
        const { loadSession } = await load('sessions');
        const saved = await loadSession(root, params.threadId, { env }).catch((error) => { throw rpcError(-32002, 'Thread not found: ' + error.message); });
        const updated = Date.parse(saved.updatedAt) ? Math.floor(Date.parse(saved.updatedAt) / 1000) : nowSeconds();
        return { thread: threadView(null, { id: saved.id, root, preview: preview(saved), name: saved.name || null, createdAt: updated, updatedAt: updated, model: saved.provider && saved.provider.model || null, turns: params.includeTurns ? historyTurns(saved.messages) : [] }) };
      }
      case 'thread/list': {
        const root = await workspace(params.cwd);
        const { listSessions } = await load('sessions');
        const all = await listSessions(root, { env });
        const start = Math.max(0, Number.parseInt(params.cursor || '0', 10) || 0);
        const limit = Math.min(200, Math.max(1, Number(params.limit) || 50));
        const page = all.slice(start, start + limit);
        const data = page.map((saved) => {
          const updated = Date.parse(saved.updatedAt) ? Math.floor(Date.parse(saved.updatedAt) / 1000) : nowSeconds();
          return threadView(threads.get(saved.id) || null, { id: saved.id, root, preview: saved.title || '', name: saved.name || null, createdAt: updated, updatedAt: updated, model: saved.model || null });
        });
        return { data, nextCursor: start + limit < all.length ? String(start + limit) : null, backwardsCursor: null };
      }
      case 'thread/name/set': {
        const entry = threadEntry(params.threadId);
        const name = String(params.name || '').trim().slice(0, 120);
        entry.session.name = name;
        try { const { saveSession } = await load('sessions'); await saveSession(entry.session, { env }); } catch {}
        notify('thread/name/updated', { threadId: params.threadId, threadName: name || null });
        return {};
      }
      case 'turn/start': {
        const entry = threadEntry(params.threadId);
        if (entry.turn) throw rpcError(-32000, 'A turn is already running in this thread. Use turn/steer or turn/interrupt.');
        const { text, images } = await expand(entry, params.input);
        if (!text && !images.length) throw rpcError(-32602, 'input needs at least one text, mention or image item.');
        if (MODES.has(permissionModeFor(params))) {
          const mode = permissionModeFor(params);
          if (typeof entry.session.permissions.setMode === 'function') entry.session.permissions.setMode(mode); else entry.session.permissions.mode = mode;
        }
        const turn = { id: randomUUID(), status: 'inProgress', error: null, startedAt: nowSeconds(), completedAt: null };
        entry.turn = turn;
        entry.controller = new AbortController();
        const userItem = { type: 'userMessage', id: 'item-' + randomUUID(), clientId: params.clientUserMessageId || null, content: Array.isArray(params.input) ? params.input : [] };
        // Reply first, then stream: clients expect the turn id before its events.
        queueMicrotask(() => {
          notify('turn/started', { threadId: params.threadId, turn: turnView(turn) });
          notify('thread/status/changed', { threadId: params.threadId, status: threadStatus(entry) });
          notify('item/started', { item: userItem, threadId: params.threadId, turnId: turn.id, startedAtMs: Date.now() });
          notify('item/completed', { item: userItem, threadId: params.threadId, turnId: turn.id, completedAtMs: Date.now() });
          runTurn(entry, turn, text, images).catch((error) => log('turn failed: ' + error.message));
        });
        return { turn: turnView(turn) };
      }
      case 'turn/steer': {
        const entry = threadEntry(params.threadId);
        if (!entry.turn) throw rpcError(-32000, 'No turn is running in this thread.');
        if (params.expectedTurnId && params.expectedTurnId !== entry.turn.id) throw rpcError(-32000, 'expectedTurnId ' + params.expectedTurnId + ' is not the active turn ' + entry.turn.id + '.');
        const { text } = inputToPrompt(params.input, entry.root);
        const { steerSession } = await load('agent');
        if (!text || !steerSession(entry.session, text)) throw rpcError(-32000, 'Steering was not accepted (empty input or the steering queue is full).');
        return { turnId: entry.turn.id };
      }
      case 'turn/interrupt': {
        const entry = threadEntry(params.threadId);
        if (entry.turn && (!params.turnId || params.turnId === entry.turn.id) && entry.controller) entry.controller.abort();
        return {};
      }
      case 'model/list': {
        const { loadConfig } = await load('config');
        const config = await loadConfig({ env });
        const id = config.model || '';
        const data = id ? [{ id, model: id, displayName: id, description: 'Configured OASIS model (' + (config.protocol || 'provider') + ')', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: null, inputModalities: ['text', 'image'], isDefault: true }] : [];
        return { data, nextCursor: null };
      }
      default:
        throw rpcError(-32601, 'Method not found: ' + method);
    }
  }

  async function receive(line) {
    let message;
    try { message = JSON.parse(String(line)); } catch { send({ id: null, error: { code: -32700, message: 'Parse error' } }); return; }
    if (!message || typeof message !== 'object') return;
    if (!message.method && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error'))) {
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); if (message.error) waiter.reject(new Error(message.error.message || 'client error')); else waiter.resolve(message.result); }
      return;
    }
    if (typeof message.method !== 'string') return;
    const isRequest = Object.hasOwn(message, 'id') && message.id !== null;
    if (!isRequest) return; // notifications such as `initialized` need no reply
    try {
      const result = await handle(message.method, message.params || {});
      send({ id: message.id, result: result === undefined ? null : result });
    } catch (error) {
      send({ id: message.id, error: error.rpc || { code: -32603, message: String(error && error.message || error) } });
    }
  }

  async function close() {
    if (closed) return;
    for (const entry of threads.values()) if (entry.controller) entry.controller.abort();
    for (const waiter of pending.values()) waiter.reject(new Error('connection closed'));
    pending.clear();
    for (const entry of threads.values()) {
      try { const { closeSession } = await load('agent'); if (closeSession) await closeSession(entry.session); } catch {}
    }
    closed = true;
    threads.clear();
  }

  return { receive, close, threads };
}

export async function serveCodexAppServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const server = createCodexAppServer({ ...options, write: (line) => output.write(line) });
  const lines = createInterface({ input, crlfDelay: Infinity });
  // Requests run concurrently so approvals and interrupts are read while a turn runs.
  const inflight = new Set();
  for await (const line of lines) {
    if (!line.trim()) continue;
    const task = server.receive(line).catch((error) => process.stderr.write('[oasis app-server] ' + error.message + '\n'));
    inflight.add(task); task.finally(() => inflight.delete(task));
  }
  await Promise.allSettled([...inflight]);
  await server.close();
}
