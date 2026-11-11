// Codex App Server compatible server: `oasis app-server` speaks the core of the
// Codex app-server v2 protocol (https://learn.chatgpt.com/docs/app-server) on
// stdin/stdout, so a client written for `codex app-server` can drive the OASIS
// runtime with any model OASIS supports. Messages are JSON-RPC 2.0, one per
// line; the "jsonrpc" field may be omitted, as in Codex.
//
// Implemented methods: initialize (+ initialized notification), thread/start,
// thread/resume, thread/fork, thread/read, thread/list (archived, searchTerm,
// excludedThreadIds), thread/name/set, thread/loaded/list, thread/unsubscribe,
// thread/archive, thread/unarchive, thread/delete, thread/compact/start,
// thread/turns/list, skills/list, mcpServerStatus/list (for a loaded thread), turn/start,
// thread/shellCommand, config/read, hooks/list, account/read, turn/steer, turn/interrupt, review/start (inline), model/list, and the host
// methods in codex-app-server-host.mjs: fs/* (readFile, writeFile,
// createDirectory, getMetadata, readDirectory, remove, copy, watch, unwatch)
// command/exec (+ write, resize, terminate) and fuzzyFileSearch, confined to
// the workspace roots.
// Notifications sent: thread/started, thread/status/changed, thread/name/updated,
// thread/archived, thread/unarchived, thread/deleted, thread/closed, thread/compacted,
// turn/started, turn/completed, turn/plan/updated, item/started, item/completed,
// item/agentMessage/delta, item/commandExecution/outputDelta (final output only),
// serverRequest/resolved, fs/changed, command/exec/outputDelta.
// Server requests sent: item/commandExecution/requestApproval and
// item/fileChange/requestApproval (decisions accept, acceptForSession, decline,
// cancel), plus item/tool/requestUserInput for experimentalApi clients. Everything else answers -32601 "Method not found".
//
// Field names and item shapes follow codex-rs/app-server-protocol (Apache-2.0);
// this is an independent implementation, no Codex code is included.
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { createTwoFilesPatch } from 'diff';
import { createAppServerHost } from './codex-app-server-host.mjs';

export const APP_SERVER_PLATFORM = { family: process.platform === 'win32' ? 'windows' : 'unix', os: process.platform === 'darwin' ? 'macos' : process.platform };

export const EXECUTE_TOOLS = new Set(['run_command', 'run_shell', 'powershell', 'monitor_command', 'auto_test']);
export const FILE_TOOLS = new Set(['edit_file', 'write_file', 'multi_edit', 'notebook_edit', 'delete_file', 'move_file', 'apply_patch']);
const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto']);
// OASIS hook events that have a Codex HookEventName (lowerCamelCase there).
const CODEX_HOOK_EVENTS = new Set(['PreToolUse', 'PermissionRequest', 'PostToolUse', 'PreCompact', 'PostCompact', 'SessionStart', 'SessionEnd', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop']);
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

export function resultText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'object') {
    const pieces = [value.stdout, value.stderr, value.output, value.error, value.message].filter((piece) => typeof piece === 'string' && piece);
    if (pieces.length) return pieces.join('\n');
  }
  try { return JSON.stringify(value); } catch { return String(value); }
}

export function isFailure(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.error || value.ok === false || value.cancelled || value.timedOut) return true;
  return typeof value.exitCode === 'number' && value.exitCode !== 0;
}

export function toolPaths(root, name, args = {}) {
  const list = [];
  for (const key of ['path', 'file', 'from', 'to', 'destination']) if (typeof args[key] === 'string') list.push(path.resolve(root, args[key]));
  if (name === 'apply_patch' && typeof args.patch === 'string') {
    for (const match of args.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) list.push(path.resolve(root, match[1].trim()));
  }
  return [...new Set(list)];
}

export function readSmall(file) {
  try { const info = statSync(file); return info.isFile() && info.size <= MAX_FILE ? readFileSync(file, 'utf8') : null; } catch { return null; }
}

// config/read never returns credentials: values under keys that look like
// secrets (apiKey, token, password, env, headers...) are replaced.
const SECRET_KEY = /(key|token|secret|password|passwd|credential|auth|cookie|^env$|headers?$)/i;
export function redactConfig(value, depth = 0) {
  if (depth > 12) return null;
  if (Array.isArray(value)) return value.map((entry) => redactConfig(entry, depth + 1));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = SECRET_KEY.test(key) && entry !== null && entry !== '' && typeof entry !== 'boolean' ? '[redacted]' : redactConfig(entry, depth + 1);
  return out;
}

// OASIS settings layers as Codex ConfigLayerSource values.
function layerSource(scope, file) {
  if (scope === 'managed') return { type: 'system', file };
  if (scope === 'user') return { type: 'user', file, profile: null };
  if (scope === 'project' || scope === 'local') return { type: 'project', dotCodexFolder: path.dirname(file) };
  return { type: 'sessionFlags' };
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
  let experimentalApi = false;
  let nextRequestId = 0;
  let closed = false;

  const send = (message) => { if (!closed) write(JSON.stringify(message) + '\n'); };
  const notify = (method, params) => { if (!optOut.has(method)) send({ method, params }); };
  const host = createAppServerHost({
    env, cwd: options.cwd || process.cwd(), notify, readOnly: options.permissionMode === 'plan', ...(options.host || {}),
    getSandbox: options.host && options.host.getSandbox || (async (cwd) => {
      if (env.OASIS_SANDBOX === '0') return null;
      const { loadSettings } = await import('./settings.mjs');
      const { resolveSandbox } = await import('./sandbox.mjs');
      try { return resolveSandbox(await loadSettings(cwd, { env }), cwd); } catch { return null; }
    })
  });
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
    if (name === 'slash') return import('./slash.mjs');
    if (name === 'tools') return import('./tools.mjs');
    if (name === 'terminal') return import('./terminal-ui.mjs');
    if (name === 'settings') return import('./settings.mjs');
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
      name: name ?? ((session && session.sessionName) || null), daybreakEnabled: null, turns
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
    host.addRoot(root);
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

  // ask_user_question as Codex's EXPERIMENTAL item/tool/requestUserInput, sent
  // only to clients that set capabilities.experimentalApi in initialize. The
  // reply maps question ids to { answers: [...] }; an empty or failed reply,
  // or an interrupted turn, means no answer.
  async function askUser(entry, turn, items, question) {
    const open = [...items.values()].reverse().find((item) => item.tool === 'ask_user_question' && !item.done);
    const params = {
      threadId: entry.session.sessionId, turnId: turn.id, itemId: open ? open.item.id : 'item-' + randomUUID(), isBlocking: true, autoResolutionMs: null,
      questions: [{ id: 'q1', header: question.header || 'Question', question: question.question + (question.multiSelect ? ' (you can choose more than one)' : ''), isOther: true, isSecret: false, options: question.options.map((option) => ({ label: option.label, description: option.description || '' })) }]
    };
    entry.waiting = true;
    notify('thread/status/changed', { threadId: entry.session.sessionId, status: threadStatus(entry) });
    const requestId = nextRequestId;
    let reply = null;
    try {
      const signal = entry.controller && entry.controller.signal;
      const pending = request('item/tool/requestUserInput', params);
      reply = await (signal ? Promise.race([pending, new Promise((resolve) => { if (signal.aborted) resolve(null); else signal.addEventListener('abort', () => resolve(null), { once: true }); })]) : pending);
    } catch (error) { log('requestUserInput failed: ' + error.message); }
    entry.waiting = false;
    notify('serverRequest/resolved', { threadId: entry.session.sessionId, requestId });
    notify('thread/status/changed', { threadId: entry.session.sessionId, status: threadStatus(entry) });
    const answers = reply && reply.answers && reply.answers.q1 && Array.isArray(reply.answers.q1.answers) ? reply.answers.q1.answers.filter((value) => typeof value === 'string' && value.trim()) : [];
    if (!answers.length) return null;
    return (question.multiSelect ? answers : answers.slice(0, 1)).join(', ');
  }

  async function runTurn(entry, turn, text, images, { onFinish = null } = {}) {
    const threadId = entry.session.sessionId;
    const items = new Map();
    let message = null;
    let streamed = '';
    let lastText = '';
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
      if (item.text) lastText = item.text;
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
          load('sessions').then(({ saveMidTurn }) => saveMidTurn(entry.session, { env })).catch(() => {});
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
        approval: (text, _force = false, meta = {}) => approve(entry, turn, items, text, meta),
        ...(experimentalApi ? { askUser: (question) => askUser(entry, turn, items, question) } : {})
      });
      finishMessage(message ? streamed : '');
      turn.status = entry.controller.signal.aborted ? 'interrupted' : 'completed';
      if (result && result.limitReached) turn.error = { message: 'Stopped at the tool-call limit for one turn.', codexErrorInfo: null, additionalDetails: null };
    } catch (error) {
      finishMessage(message ? streamed : '');
      turn.status = entry.controller.signal.aborted ? 'interrupted' : 'failed';
      if (turn.status === 'failed') turn.error = { message: String(error && error.message || error), codexErrorInfo: null, additionalDetails: null };
    } finally {
      try { const { saveSession, settleMidTurnSave } = await load('sessions'); await settleMidTurnSave(entry.session); await saveSession(entry.session, { env }); } catch {}
      turn.completedAt = nowSeconds();
      if (onFinish) { try { onFinish(lastText); } catch (error) { log('turn finish hook failed: ' + error.message); } }
      entry.turn = null; entry.controller = null;
      notify('turn/completed', { threadId, turn: turnView(turn) });
      notify('thread/status/changed', { threadId, status: threadStatus(entry) });
    }
  }

  // Reply first, then stream: clients expect the turn id before its events.
  // thread/compact/start: a turn holding one contextCompaction item, like
  // Codex. The reply comes first; turn/started, item/*, turn/completed follow.
  function beginCompaction(entry) {
    const threadId = entry.session.sessionId;
    const turn = { id: randomUUID(), status: 'inProgress', error: null, startedAt: nowSeconds(), completedAt: null };
    entry.turn = turn;
    entry.controller = new AbortController();
    queueMicrotask(async () => {
      notify('turn/started', { threadId, turn: turnView(turn) });
      notify('thread/status/changed', { threadId, status: threadStatus(entry) });
      const item = { type: 'contextCompaction', id: 'item-' + randomUUID() };
      notify('item/started', { item, threadId, turnId: turn.id, startedAtMs: Date.now() });
      try {
        const { compactHistoryIfNeeded } = await load('agent');
        const result = await compactHistoryIfNeeded(entry.session, { force: true, env, mustPreserve: entry.session.mustPreserve, signal: entry.controller.signal });
        if (result && result.blockedByHook) { turn.status = 'failed'; turn.error = { message: 'A PreCompact hook cancelled compaction: ' + (result.reason || 'no reason given'), codexErrorInfo: null, additionalDetails: null }; }
        else turn.status = entry.controller.signal.aborted ? 'interrupted' : 'completed';
        if (result && result.compacted) notify('thread/compacted', { threadId, turnId: turn.id });
      } catch (error) {
        turn.status = entry.controller.signal.aborted ? 'interrupted' : 'failed';
        if (turn.status === 'failed') turn.error = { message: String(error && error.message || error), codexErrorInfo: null, additionalDetails: null };
      } finally {
        notify('item/completed', { item, threadId, turnId: turn.id, completedAtMs: Date.now() });
        try { const { saveSession } = await load('sessions'); await saveSession(entry.session, { env }); } catch {}
        turn.completedAt = nowSeconds();
        entry.turn = null; entry.controller = null;
        notify('turn/completed', { threadId, turn: turnView(turn) });
        notify('thread/status/changed', { threadId, status: threadStatus(entry) });
      }
    });
    return turn;
  }

  // Unload a thread from this connection (saving it first). Used by
  // thread/unsubscribe, thread/archive and thread/delete.
  async function unloadThread(entry, { save = true } = {}) {
    if (save) { try { const { saveSession } = await load('sessions'); await saveSession(entry.session, { env }); } catch {} }
    try { const { closeSession } = await load('agent'); if (closeSession) await closeSession(entry.session); } catch {}
    threads.delete(entry.session.sessionId);
  }

  function beginTurn(entry, text, images, leadItems = [], hooks = {}) {
    const threadId = entry.session.sessionId;
    const turn = { id: randomUUID(), status: 'inProgress', error: null, startedAt: nowSeconds(), completedAt: null };
    entry.turn = turn;
    entry.controller = new AbortController();
    queueMicrotask(() => {
      notify('turn/started', { threadId, turn: turnView(turn) });
      notify('thread/status/changed', { threadId, status: threadStatus(entry) });
      for (const item of leadItems) {
        notify('item/started', { item, threadId, turnId: turn.id, startedAtMs: Date.now() });
        notify('item/completed', { item, threadId, turnId: turn.id, completedAtMs: Date.now() });
      }
      runTurn(entry, turn, text, images, hooks).catch((error) => log('turn failed: ' + error.message));
    });
    return turn;
  }

  // thread/shellCommand: the user's own `!` command, run on this computer in
  // the thread's folder with the user's shell (no agent sandbox, as in Codex).
  // It shows as a commandExecution item with source "userShell" in the active
  // turn, or in a turn of its own when the thread is idle. The model sees the
  // command and its output with the next request, like `!` in the terminal.
  async function runUserShell(entry, turn, command, timeoutMs, signal) {
    const threadId = entry.session.sessionId;
    const item = { type: 'commandExecution', id: 'item-' + randomUUID(), pluginId: null, scriptPath: null, command, cwd: entry.root, processId: null, source: 'userShell', status: 'inProgress', commandActions: [], aggregatedOutput: null, exitCode: null, durationMs: null };
    const started = Date.now();
    notify('item/started', { item, threadId, turnId: turn.id, startedAtMs: started });
    const { runShellPassthrough, shellContextBlock } = await load('terminal');
    const ran = await runShellPassthrough(command, { root: entry.root, env, output: { write() {} }, signal, timeoutMs, trapSigint: false });
    item.durationMs = Date.now() - started;
    item.aggregatedOutput = ran.output + (ran.timedOut ? (ran.output && !ran.output.endsWith('\n') ? '\n' : '') + '[timed out after ' + timeoutMs + ' ms]' : '');
    item.exitCode = ran.timedOut || ran.cancelled ? null : ran.code;
    item.status = ran.timedOut || ran.cancelled || ran.code !== 0 ? 'failed' : 'completed';
    if (item.aggregatedOutput) notify('item/commandExecution/outputDelta', { threadId, turnId: turn.id, itemId: item.id, delta: item.aggregatedOutput });
    notify('item/completed', { item, threadId, turnId: turn.id, completedAtMs: Date.now() });
    const block = shellContextBlock([{ command, code: ran.timedOut ? 'timeout' : ran.code, output: ran.output }]);
    return { item, block };
  }

  function beginShellTurn(entry, command, timeoutMs) {
    const threadId = entry.session.sessionId;
    const turn = { id: randomUUID(), status: 'inProgress', error: null, startedAt: nowSeconds(), completedAt: null, shell: true };
    entry.turn = turn;
    entry.controller = new AbortController();
    queueMicrotask(async () => {
      notify('turn/started', { threadId, turn: turnView(turn) });
      notify('thread/status/changed', { threadId, status: threadStatus(entry) });
      try {
        const { block } = await runUserShell(entry, turn, command, timeoutMs, entry.controller.signal);
        entry.pendingShell = [...(entry.pendingShell || []), block].slice(-10);
        turn.status = entry.controller.signal.aborted ? 'interrupted' : 'completed';
      } catch (error) {
        turn.status = 'failed';
        turn.error = { message: String(error && error.message || error), codexErrorInfo: null, additionalDetails: null };
      } finally {
        turn.completedAt = nowSeconds();
        entry.turn = null; entry.controller = null;
        notify('turn/completed', { threadId, turn: turnView(turn) });
        notify('thread/status/changed', { threadId, status: threadStatus(entry) });
      }
    });
  }

  async function reviewRequest(target = {}) {
    const { reviewPrompt } = await load('slash');
    const readOnly = 'This is a read-only review: do not modify files.';
    switch (target && target.type) {
      case 'uncommittedChanges': return { label: 'current changes', prompt: reviewPrompt('code-review', '') };
      case 'baseBranch': {
        const branch = String(target.branch || '').trim();
        if (!/^[\w./@-]{1,200}$/.test(branch) || branch.startsWith('-')) throw rpcError(-32602, 'target.branch must be a branch name.');
        return { label: 'changes against ' + branch, prompt: reviewPrompt('code-review', branch) };
      }
      case 'commit': {
        const sha = String(target.sha || '').trim();
        if (!/^[0-9a-f]{4,64}$/i.test(sha)) throw rpcError(-32602, 'target.sha must be a commit hash.');
        const title = target.title ? ' (' + String(target.title).slice(0, 200) + ')' : '';
        return { label: 'commit ' + sha.slice(0, 12) + title, prompt: 'Scope: review only the changes introduced by commit ' + sha + title + '. Read them with `git show ' + sha + '`; ignore other pending changes.\n' + reviewPrompt('code-review', sha + '~1') };
      }
      case 'custom': {
        const instructions = String(target.instructions || '').trim();
        if (!instructions) throw rpcError(-32602, 'target.instructions is required.');
        return { label: instructions.slice(0, 120), prompt: instructions.slice(0, 20000) + '\n' + readOnly };
      }
      default: throw rpcError(-32602, 'target.type must be uncommittedChanges, baseBranch, commit or custom.');
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
      experimentalApi = caps.experimentalApi === true;
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
      case 'thread/turns/list': {
        if (typeof params.threadId !== 'string' || !params.threadId) throw rpcError(-32602, 'threadId is required.');
        const direction = params.sortDirection == null ? 'desc' : params.sortDirection;
        if (direction !== 'asc' && direction !== 'desc') throw rpcError(-32602, 'sortDirection must be "asc" or "desc".');
        const view = params.itemsView == null ? 'summary' : params.itemsView;
        if (!['notLoaded', 'summary', 'full'].includes(view)) throw rpcError(-32602, 'itemsView must be "notLoaded", "summary" or "full".');
        let messages;
        const loaded = threads.get(params.threadId);
        if (loaded) messages = loaded.session.messages;
        else {
          const root = await workspace(params.cwd);
          const { loadSession } = await load('sessions');
          messages = (await loadSession(root, params.threadId, { env }).catch((error) => { throw rpcError(-32002, 'Thread not found: ' + error.message); })).messages;
        }
        const ordered = historyTurns(messages);
        if (direction === 'desc') ordered.reverse();
        // Cursors are opaque to clients: the anchor turn id, and whether the
        // page starts at it (backwards cursor) or just after it (next cursor).
        let start = 0;
        if (params.cursor != null) {
          let decoded = null;
          try { decoded = JSON.parse(Buffer.from(String(params.cursor), 'base64url').toString('utf8')); } catch {}
          if (!decoded || typeof decoded.turnId !== 'string') throw rpcError(-32602, 'cursor is not valid.');
          const at = ordered.findIndex((turn) => turn.id === decoded.turnId);
          if (at < 0) throw rpcError(-32602, 'cursor refers to a turn that is no longer in this thread.');
          start = decoded.inclusive ? at : at + 1;
        }
        const limit = Math.min(200, Math.max(1, Number.parseInt(params.limit, 10) || 25));
        const page = ordered.slice(start, start + limit).map((turn) => {
          if (view === 'full') return turn;
          if (view === 'notLoaded') return { ...turn, items: [], itemsView: 'notLoaded' };
          const user = turn.items.find((item) => item.type === 'userMessage');
          const answer = [...turn.items].reverse().find((item) => item.type === 'agentMessage');
          return { ...turn, items: [user, answer].filter(Boolean), itemsView: 'summary' };
        });
        const cursor = (turnId, inclusive) => Buffer.from(JSON.stringify({ turnId, inclusive })).toString('base64url');
        return {
          data: page,
          nextCursor: start + limit < ordered.length && page.length ? cursor(page[page.length - 1].id, false) : null,
          backwardsCursor: page.length ? cursor(page[0].id, true) : null
        };
      }
      case 'thread/list': {
        const root = await workspace(params.cwd);
        const { listSessions } = await load('sessions');
        const wantArchived = params.archived === true;
        const excluded = new Set(Array.isArray(params.excludedThreadIds) ? params.excludedThreadIds.filter((id) => typeof id === 'string') : []);
        const term = typeof params.searchTerm === 'string' ? params.searchTerm.trim().toLowerCase() : '';
        const all = (await listSessions(root, { env })).filter((saved) => Boolean(saved.archived) === wantArchived && !excluded.has(saved.id) && (!term || String(saved.title || '').toLowerCase().includes(term)));
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
        entry.session.sessionName = name;
        try { const { saveSession } = await load('sessions'); await saveSession(entry.session, { env }); } catch {}
        notify('thread/name/updated', { threadId: params.threadId, threadName: name || null });
        return {};
      }
      case 'thread/loaded/list': {
        const ids = [...threads.keys()];
        const start = Math.max(0, Number.parseInt(params.cursor || '0', 10) || 0);
        const limit = Math.min(500, Math.max(1, Number(params.limit) || 100));
        return { data: ids.slice(start, start + limit), nextCursor: start + limit < ids.length ? String(start + limit) : null };
      }
      case 'thread/unsubscribe': {
        if (typeof params.threadId !== 'string' || !params.threadId) throw rpcError(-32602, 'threadId is required.');
        const entry = threads.get(params.threadId);
        if (!entry) return { status: 'notLoaded' };
        if (entry.controller) entry.controller.abort();
        await unloadThread(entry);
        notify('thread/closed', { threadId: params.threadId });
        return { status: 'unsubscribed' };
      }
      case 'thread/archive':
      case 'thread/unarchive': {
        if (typeof params.threadId !== 'string' || !params.threadId) throw rpcError(-32602, 'threadId is required.');
        const archive = method === 'thread/archive';
        const entry = threads.get(params.threadId);
        if (entry && entry.turn) throw rpcError(-32600, 'Interrupt the running turn before archiving this thread.');
        const root = entry ? entry.root : await workspace(params.cwd);
        const { saveSession, setSessionArchived, loadSession } = await load('sessions');
        if (entry) { entry.session.archived = archive; await saveSession(entry.session, { env }); }
        else {
          try { await setSessionArchived(root, params.threadId, archive, { env }); }
          catch (error) { throw rpcError(-32002, 'Thread not found: ' + error.message); }
        }
        // Archiving unloads the thread, as in Codex; unarchive returns the thread.
        if (archive && entry) await unloadThread(entry, { save: false });
        notify(archive ? 'thread/archived' : 'thread/unarchived', { threadId: params.threadId });
        if (archive) return {};
        if (entry) return { thread: threadView(entry, { preview: preview(entry.session) }) };
        const saved = await loadSession(root, params.threadId, { env });
        const updated = Date.parse(saved.updatedAt) ? Math.floor(Date.parse(saved.updatedAt) / 1000) : nowSeconds();
        return { thread: threadView(null, { id: saved.id, root, preview: preview(saved), name: saved.name || null, createdAt: updated, updatedAt: updated, model: saved.provider && saved.provider.model || null }) };
      }
      case 'thread/delete': {
        if (typeof params.threadId !== 'string' || !params.threadId) throw rpcError(-32602, 'threadId is required.');
        const entry = threads.get(params.threadId);
        if (entry && entry.turn) throw rpcError(-32600, 'Interrupt the running turn before deleting this thread.');
        const root = entry ? entry.root : await workspace(params.cwd);
        if (entry) await unloadThread(entry, { save: false });
        const { deleteSession } = await load('sessions');
        try { await deleteSession(root, params.threadId, { env }); }
        catch (error) { if (!entry) throw rpcError(-32002, 'Thread not found: ' + error.message); }
        notify('thread/deleted', { threadId: params.threadId });
        return {};
      }
      case 'thread/compact/start': {
        const entry = threadEntry(params.threadId);
        if (entry.turn) throw rpcError(-32000, 'A turn is already running in this thread.');
        beginCompaction(entry);
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
        const userItem = { type: 'userMessage', id: 'item-' + randomUUID(), clientId: params.clientUserMessageId || null, content: Array.isArray(params.input) ? params.input : [] };
        const shellContext = entry.pendingShell && entry.pendingShell.length ? 'Commands I ran in my terminal (for context):\n' + entry.pendingShell.join('\n\n') + '\n\n' : '';
        entry.pendingShell = [];
        const turn = beginTurn(entry, shellContext + text, images, [userItem]);
        return { turn: turnView(turn) };
      }
      case 'review/start': {
        const entry = threadEntry(params.threadId);
        if (entry.turn) throw rpcError(-32000, 'A turn is already running in this thread.');
        if (params.delivery && params.delivery !== 'inline') throw rpcError(-32602, 'Only inline review delivery is supported.');
        const { label, prompt } = await reviewRequest(params.target);
        const threadId = entry.session.sessionId;
        let turnId = null;
        const entered = { type: 'enteredReviewMode', id: 'item-' + randomUUID(), review: label };
        const turn = beginTurn(entry, prompt, [], [entered], {
          onFinish: (text) => {
            const exited = { type: 'exitedReviewMode', id: 'item-' + randomUUID(), review: text || '' };
            notify('item/started', { item: exited, threadId, turnId, startedAtMs: Date.now() });
            notify('item/completed', { item: exited, threadId, turnId, completedAtMs: Date.now() });
          }
        });
        turnId = turn.id;
        return { turn: turnView(turn), reviewThreadId: threadId };
      }
      case 'config/read': {
        // The effective OASIS configuration in Codex's Config shape. Fields
        // Codex has and OASIS does not stay null; OASIS-only values are under
        // "oasis". Credentials are never included.
        const root = await workspace(params.cwd);
        const { loadConfig } = await load('config');
        const { loadSettings } = await load('settings');
        const [config, settings] = await Promise.all([loadConfig({ env }), loadSettings(root, { env, skipPlugins: true })]);
        const mode = options.permissionMode || settings.permissions.defaultMode || 'default';
        const sandboxOn = Boolean(settings.sandbox && settings.sandbox.enabled);
        const userConfig = { type: 'user', file: config.configPath, profile: null };
        const fromEnv = (name) => (env[name] ? { type: 'sessionFlags' } : userConfig);
        const version = (text) => createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
        const result = {
          config: {
            model: config.model || null, review_model: null, model_context_window: Number.isInteger(config.contextWindow) ? config.contextWindow : null,
            model_auto_compact_token_limit: null, model_auto_compact_token_limit_scope: null, model_provider: config.protocol || null,
            approval_policy: mode === 'bypassPermissions' || mode === 'dontAsk' ? 'never' : 'on-request',
            sandbox_mode: mode === 'plan' ? 'read-only' : sandboxOn ? 'workspace-write' : 'danger-full-access',
            sandbox_workspace_write: sandboxOn ? { writable_roots: settings.sandbox.writable || [], network_access: Boolean(settings.sandbox.network), exclude_tmpdir_env_var: false, exclude_slash_tmp: false } : null,
            forced_chatgpt_workspace_id: null, forced_login_method: null, web_search: null, client_search_provider: null, tools: null,
            instructions: null, developer_instructions: null, compact_prompt: null,
            model_reasoning_effort: typeof config.reasoningEffort === 'string' && config.reasoningEffort ? config.reasoningEffort : null,
            model_reasoning_summary: null, model_verbosity: null, service_tier: null, analytics: null, apps: null, browser_use: null, computer_use: null, desktop: null,
            oasis: { permissionMode: mode, baseUrl: config.baseURL || null, configured: Boolean(config.configured), maxSteps: config.maxSteps, maxToolCalls: config.maxToolCalls, sandbox: { enabled: sandboxOn, network: Boolean(settings.sandbox && settings.sandbox.network) }, workspaceTrusted: Boolean(settings.trusted) }
          },
          origins: {
            model: { name: fromEnv('OASIS_MODEL'), version: '' },
            model_provider: { name: fromEnv('OASIS_PROTOCOL'), version: '' },
            ...(Number.isInteger(config.contextWindow) ? { model_context_window: { name: userConfig, version: '' } } : {})
          }
        };
        if (params.includeLayers) {
          const { readFile } = await import('node:fs/promises');
          result.layers = [];
          for (const { scope, file } of settings.sources || []) {
            const text = file && path.isAbsolute(file) ? await readFile(file, 'utf8').catch(() => null) : null;
            let parsed = null;
            try { parsed = text === null ? null : JSON.parse(text); } catch { parsed = null; }
            const untrusted = (scope === 'project' || scope === 'local') && !settings.trusted;
            result.layers.push({ name: layerSource(scope, file), version: text === null ? '' : version(text), config: redactConfig(parsed || {}), ...(untrusted ? { disabledReason: 'This folder is not trusted: its allow rules, hooks and mode or sandbox changes are ignored; deny and ask rules still apply. Run `oasis trust` to trust it.' } : {}) });
          }
        }
        return result;
      }
      case 'account/read': {
        // OASIS signs in to model providers with their own keys or local
        // servers, never with an OpenAI/ChatGPT account, so clients should not
        // show a ChatGPT login. A configured provider reads as an API-key account.
        const { loadConfig } = await load('config');
        const config = await loadConfig({ env }).catch(() => ({ configured: false }));
        return { account: config.configured ? { type: 'apiKey' } : null, userId: null, requiresOpenaiAuth: false, workspaceRouting: null };
      }
      case 'hooks/list': {
        // OASIS hooks in Codex's HooksListEntry shape. Codex has a fixed set of
        // event names and handler types, so hooks on other OASIS events (for
        // example PostToolUseFailure or Notification) and HTTP hooks are
        // counted in `warnings` instead of being listed.
        let cwds;
        if (typeof params.threadId === 'string' && params.threadId) cwds = [threadEntry(params.threadId).root];
        else cwds = Array.isArray(params.cwds) && params.cwds.length ? params.cwds.filter((cwd) => typeof cwd === 'string') : [undefined];
        const { loadSettings } = await load('settings');
        const { defaultTimeout } = await import('./hooks.mjs');
        const data = [];
        for (const raw of cwds) {
          let root;
          try { root = await workspace(raw); } catch (error) { data.push({ cwd: String(raw || ''), hooks: [], warnings: [], errors: [{ path: String(raw || ''), message: error.message }] }); continue; }
          const settings = await loadSettings(root, { env });
          const hooks = [];
          const skipped = { events: new Set(), http: 0 };
          let order = 0;
          for (const [event, groups] of Object.entries(settings.hooks || {})) {
            const eventName = CODEX_HOOK_EVENTS.has(event) ? event[0].toLowerCase() + event.slice(1) : null;
            for (const [groupIndex, group] of groups.entries()) {
              for (const [hookIndex, hook] of (group.hooks || []).entries()) {
                if (!eventName) { skipped.events.add(event); continue; }
                const handler = hook.type === 'command' ? { handlerType: 'command', command: hook.command, async: Boolean(hook.async) }
                  : hook.type === 'mcp_tool' ? { handlerType: 'mcpTool', server: hook.server, tool: hook.tool }
                  : hook.type === 'prompt' ? { handlerType: 'prompt' } : hook.type === 'agent' ? { handlerType: 'agent' } : null;
                if (!handler) { skipped.http++; continue; }
                const source = String(group.source || '');
                const managed = source === 'managed';
                const sourcePath = group.sourceFile || '';
                hooks.push({
                  key: [sourcePath || source, event, groupIndex, hookIndex].join(':'), eventName, ...handler,
                  matcher: group.matcher || null, timeoutSec: defaultTimeout(hook, event), statusMessage: hook.statusMessage || null, additionalContextLimit: null,
                  sourcePath, source: managed ? 'system' : source === 'user' ? 'user' : source === 'project' || source === 'local' ? 'project' : source === 'flag' ? 'sessionFlags' : source.startsWith('plugin:') ? 'plugin' : 'unknown',
                  pluginId: source.startsWith('plugin:') ? source.slice(7) : null, environmentId: null, displayOrder: order++, enabled: true, isManaged: managed,
                  currentHash: createHash('sha256').update(JSON.stringify({ event, matcher: group.matcher || '', hook })).digest('hex'), trustStatus: managed ? 'managed' : 'trusted'
                });
              }
            }
          }
          const warnings = [];
          if (skipped.events.size) warnings.push('Hooks on ' + [...skipped.events].sort().join(', ') + ' run in OASIS but have no Codex event name, so they are not listed.');
          if (skipped.http) warnings.push(skipped.http + ' HTTP hook' + (skipped.http === 1 ? '' : 's') + ' not listed: Codex has no HTTP hook type.');
          if (settings.hooksDisabled) warnings.push(settings.hooksDisabled === 'managed' ? 'Managed settings turn every hook off (disableAllHooks).' : 'Only managed hooks run (' + (settings.hooksDisabled === 'settings' ? 'disableAllHooks' : 'allowManagedHooksOnly') + ').');
          for (const file of settings.ignoredUntrusted || []) warnings.push('Hooks and other loosening settings in ' + file + ' are ignored until this folder is trusted (`oasis trust`).');
          data.push({ cwd: root, hooks, warnings, errors: [] });
        }
        return { data };
      }
      case 'thread/shellCommand': {
        const entry = threadEntry(params.threadId);
        const command = typeof params.command === 'string' ? params.command.trim() : '';
        if (!command) throw rpcError(-32602, 'command must be a non-empty string.');
        const timeoutMs = params.timeoutMs === undefined || params.timeoutMs === null ? 60 * 60 * 1000 : Number(params.timeoutMs);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 0) throw rpcError(-32602, 'timeoutMs must be a non-negative integer.');
        const mode = entry.session.permissions && entry.session.permissions.mode;
        if (mode === 'plan' || options.permissionMode === 'plan') throw rpcError(-32000, 'Shell commands are turned off in plan (read-only) mode.');
        if (entry.turn && entry.turn.status === 'inProgress' && entry.controller) {
          // A running turn: show the command in it and pass the result to the
          // model as a steering message, so it sees it before its next step.
          const turn = entry.turn;
          const signal = entry.controller.signal;
          queueMicrotask(() => {
            runUserShell(entry, turn, command, timeoutMs, signal).then(async ({ block }) => {
              const { steerSession } = await load('agent');
              const text = 'Command I ran in my terminal (for context):\n' + block;
              if (turn.shell || !(entry.turn === turn && steerSession(entry.session, text))) entry.pendingShell = [...(entry.pendingShell || []), block].slice(-10);
            }).catch((error) => log('shell command failed: ' + error.message));
          });
        } else {
          beginShellTurn(entry, command, timeoutMs);
        }
        return {};
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
      case 'skills/list': {
        const cwds = Array.isArray(params.cwds) && params.cwds.length ? params.cwds.filter((cwd) => typeof cwd === 'string') : [undefined];
        const { listAvailableSkills, skillLocation } = await load('tools');
        const data = [];
        for (const cwd of cwds.slice(0, 20)) {
          const root = await workspace(cwd);
          try {
            const skills = await listAvailableSkills(root, { env });
            data.push({ cwd: root, errors: [], skills: skills.map((item) => {
              const where = skillLocation(root, item);
              return { name: item.name, description: String(item.description || ''), shortDescription: null, interface: null, dependencies: null, path: where.path || '', scope: where.scope, enabled: true, pluginId: item.plugin || null };
            }) });
          } catch (error) { data.push({ cwd: root, skills: [], errors: [{ path: root, message: String(error && error.message || error) }] }); }
        }
        return { data };
      }
      case 'mcpServerStatus/list': {
        // OASIS connects MCP servers per thread, so the status comes from a
        // loaded thread: the one named, or the only one loaded.
        const entry = typeof params.threadId === 'string' && params.threadId ? threadEntry(params.threadId) : (threads.size === 1 ? [...threads.values()][0] : null);
        if (!entry) throw rpcError(-32602, 'Pass the threadId of a loaded thread; OASIS starts MCP servers per thread.');
        if (entry.session.mcpConnecting) await Promise.race([entry.session.mcpConnecting.catch(() => {}), new Promise((resolve) => setTimeout(resolve, 0))]);
        const toolsOnly = params.detail === 'toolsAndAuthOnly';
        const origin = (url) => { try { return new URL(url).origin; } catch { return null; } };
        const rows = [];
        for (const [name, client] of entry.session.mcpClients || new Map()) {
          const config = client.config || {};
          const tools = {};
          for (const tool of Array.isArray(client.tools) ? client.tools : []) tools[tool.name] = tool;
          rows.push({ name, runtimeStatus: 'connected', pluginId: null, httpOrigin: config.url ? origin(config.url) : null, serverInfo: toolsOnly ? null : (client.serverInfo || null), serverCapabilities: toolsOnly ? null : (client.capabilities || null), toolListMeta: null, tools, toolsError: null, resources: toolsOnly ? [] : (client.resources || []), resourceTemplates: toolsOnly ? [] : (client.resourceTemplates || []), authStatus: config.oauth ? 'oAuth' : (config.headers && Object.keys(config.headers).some((key) => key.toLowerCase() === 'authorization') ? 'bearerToken' : (config.url ? 'unknown' : 'unsupported')) });
        }
        for (const failure of entry.session.mcpFailures || []) {
          if (!failure || !failure.name || rows.some((row) => row.name === failure.name)) continue;
          rows.push({ name: String(failure.name), runtimeStatus: /auth|401|login/i.test(String(failure.error || '')) ? 'authenticationRequired' : 'failed', pluginId: null, httpOrigin: null, serverInfo: null, serverCapabilities: null, toolListMeta: null, tools: {}, toolsError: String(failure.error || 'failed to start').slice(0, 2000), resources: [], resourceTemplates: [], authStatus: 'unknown' });
        }
        const filtered = typeof params.serverName === 'string' && params.serverName ? rows.filter((row) => row.name === params.serverName) : rows;
        const start = Math.max(0, Number.parseInt(params.cursor || '0', 10) || 0);
        const limit = Math.min(200, Math.max(1, Number(params.limit) || 100));
        return { data: filtered.slice(start, start + limit), nextCursor: start + limit < filtered.length ? String(start + limit) : null };
      }
      case 'model/list': {
        const { loadConfig } = await load('config');
        const config = await loadConfig({ env });
        const id = config.model || '';
        const data = id ? [{ id, model: id, displayName: id, description: 'Configured OASIS model (' + (config.protocol || 'provider') + ')', hidden: false, supportedReasoningEfforts: [], defaultReasoningEffort: null, inputModalities: ['text', 'image'], isDefault: true }] : [];
        return { data, nextCursor: null };
      }
      default:
        if (host.has(method)) return host.handle(method, params);
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
    host.close();
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
