// Agent Client Protocol (ACP) server: `oasis acp` speaks newline-delimited
// JSON-RPC 2.0 on stdin/stdout so editors that implement ACP (Zed, JetBrains
// AI Assistant, Neovim's CodeCompanion/avante, Emacs agent-shell, marimo, ...)
// can run OASIS as their coding agent. Spec: https://agentclientprotocol.com
// Framing, request ids, schema validation of incoming params and error replies
// come from the official SDK (@agentclientprotocol/sdk, Zed Industries).
//
// Agent methods: initialize, authenticate, logout, session/new, session/load,
// session/resume, session/list, session/close, session/delete,
// session/prompt, session/set_mode, session/set_config_option (mode, model),
// session/cancel (notification).
// Client calls made by OASIS: session/update (notification: message chunks,
// tool calls, plan, current_mode_update, config_option_update,
// session_info_update, usage_update) and session/request_permission (request). Diagnostics go to stderr only;
// stdout carries protocol messages exclusively.
import path from 'node:path';
import { stat } from 'node:fs/promises';
import { readFileSync, statSync } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import { agent as acpAgent, methods, ndJsonStream, RequestError } from '@agentclientprotocol/sdk';
import { contextWindowSize } from './context.mjs';
import { switchSessionModel } from './model-switch.mjs';

export const ACP_PROTOCOL_VERSION = 1;

const MODE_INFO = [
  { id: 'default', name: 'Ask', description: 'Ask before edits and commands that are not already allowed.' },
  { id: 'acceptEdits', name: 'Accept edits', description: 'Apply file edits without asking; still ask for commands.' },
  { id: 'plan', name: 'Plan', description: 'Read-only investigation and a plan; no edits or commands.' },
  { id: 'auto', name: 'Auto', description: 'Model-free risk checks decide; risky actions still ask.' }
];

const KIND_BY_TOOL = {
  read_file: 'read', list_files: 'read', glob_files: 'search', search_files: 'search', grep: 'search', ast_grep: 'search', repo_map: 'search', session_search: 'search', memory_search: 'search',
  edit_file: 'edit', multi_edit: 'edit', write_file: 'edit', apply_patch: 'edit', notebook_edit: 'edit', generate_image: 'edit', text_to_speech: 'edit',
  delete_file: 'delete', move_file: 'move',
  run_command: 'execute', run_shell: 'execute', powershell: 'execute', monitor_command: 'execute',
  fetch_url: 'fetch', web_search: 'fetch',
  todo_write: 'think', exit_plan_mode: 'think'
};

const DIFF_TOOLS = new Set(['edit_file', 'write_file', 'multi_edit', 'notebook_edit']);

const TERMINAL_OUTPUT_LIMIT = 256 * 1024;
const LIST_PAGE = 50;

export function toolKind(name) {
  return KIND_BY_TOOL[name] || (String(name).startsWith('mcp_') ? 'other' : 'other');
}

function toolTitle(name, args = {}) {
  const target = args.path || args.file_path || args.pattern || args.query || args.url || '';
  if (name === 'run_command') return 'Run ' + [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ').slice(0, 160);
  if (name === 'run_shell' || name === 'powershell') return 'Run ' + String(args.command || args.script || '').slice(0, 160);
  return name + (target ? ' ' + String(target).slice(0, 160) : '');
}

function toolLocations(root, args = {}) {
  const raw = args.path || args.file_path;
  if (typeof raw !== 'string' || !raw) return [];
  return [{ path: path.resolve(root, raw), ...(Number.isInteger(args.line) ? { line: args.line } : {}) }];
}

function resultText(value) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value.output === 'string') return value.output;
  if (typeof value.message === 'string' && Object.keys(value).length <= 3) return value.message;
  const text = [value.stdout, value.stderr].filter((item) => typeof item === 'string' && item).join('\n');
  if (text) return text;
  try { return JSON.stringify(value, null, 2); } catch { return String(value); }
}

function isFailure(value) {
  return Boolean(value && typeof value === 'object' && (value.error || value.approved === false || (value.exitCode !== undefined && value.exitCode !== 0)));
}

// Turns ACP prompt content blocks into OASIS prompt text. Resource links become
// @path mentions (expanded by the normal file-mention logic); embedded resources
// are inlined as untrusted context; images are passed through when supported.
export function promptFromBlocks(blocks = [], root = process.cwd()) {
  const parts = [];
  const images = [];
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'resource_link' && typeof block.uri === 'string') {
      const file = block.uri.startsWith('file://') ? decodeURIComponent(new URL(block.uri).pathname) : '';
      const relative = file ? path.relative(root, file) : '';
      parts.push(file && !relative.startsWith('..') && !path.isAbsolute(relative) ? '@' + relative.split(path.sep).join('/') : '[' + (block.name || 'link') + '](' + block.uri + ')');
    } else if (block.type === 'resource' && block.resource && typeof block.resource.text === 'string') {
      parts.push('<context uri="' + String(block.resource.uri || '').replace(/"/g, '') + '">\n' + block.resource.text.slice(0, 200000) + '\n</context>');
    } else if (block.type === 'image' && typeof block.data === 'string') {
      images.push({ mediaType: block.mimeType || 'image/png', data: block.data });
    }
  }
  return { text: parts.join('\n\n'), images };
}

function rpcError(code, message, data) {
  return new RequestError(code, message, data);
}

export function createAcpServer(options = {}) {
  const env = options.env || process.env;
  const write = options.write || ((line) => process.stdout.write(line));
  const log = options.log || ((text) => process.stderr.write('[oasis acp] ' + text + '\n'));
  const deps = options.deps || {};
  const sessions = new Map();
  let clientCapabilities = {};
  let connection = null;

  // Calls to the editor go through the SDK connection once it is open.
  // ask_user_question over ACP elicitation (unstable in ACP v1): a form with
  // the choices plus a free-text "Other" field, shown only when the client
  // advertised elicitation.form in initialize. Decline, cancel, an error or an
  // interrupted turn count as "no answer", so the model decides and says so.
  const canElicitForm = () => Boolean(clientCapabilities && clientCapabilities.elicitation && clientCapabilities.elicitation.form);
  const elicitAnswer = async (sessionId, question, { toolCallId, signal } = {}) => {
    const choices = question.options.map((option) => ({ const: option.label, title: option.label, ...(option.description ? { description: option.description } : {}) }));
    const title = question.header || 'Answer';
    const answer = question.multiSelect
      ? { type: 'array', title, description: 'Choose one or more', items: { anyOf: choices } }
      : { type: 'string', title, description: 'Choose one', oneOf: choices };
    const params = {
      mode: 'form', sessionId, ...(toolCallId ? { toolCallId } : {}), message: question.question,
      requestedSchema: { type: 'object', properties: { answer, other: { type: 'string', title: 'Other', description: 'Or type your own answer' } } }
    };
    let response;
    try {
      const pending = request('elicitation/create', params);
      response = await (signal ? Promise.race([pending, new Promise((resolve) => { if (signal.aborted) resolve(null); else signal.addEventListener('abort', () => resolve(null), { once: true }); })]) : pending);
    } catch (error) { log('elicitation/create failed: ' + error.message); return null; }
    if (!response || response.action !== 'accept' || !response.content) return null;
    const other = typeof response.content.other === 'string' ? response.content.other.trim() : '';
    if (other) return other;
    const picked = response.content.answer;
    const valid = new Set(question.options.map((option) => option.label));
    const labels = (Array.isArray(picked) ? picked : [picked]).filter((value) => typeof value === 'string' && valid.has(value));
    return labels.length ? (question.multiSelect ? labels : labels.slice(0, 1)).join(', ') : null;
  };
  const request = (method, params) => connection ? connection.client.request(method, params) : Promise.reject(new Error('connection closed'));
  const update = (sessionId, payload) => {
    if (!connection) return;
    connection.client.notify('session/update', { sessionId, update: payload }).catch((error) => log('session/update failed: ' + error.message));
  };

  async function load(name) {
    if (deps[name]) return deps[name];
    if (name === 'agent') return import('./agent.mjs');
    if (name === 'config') return import('./config.mjs');
    if (name === 'sessions') return import('./sessions.mjs');
    if (name === 'mentions') return import('./commands.mjs');
    throw new Error('unknown dependency ' + name);
  }

  function acpMcpServers(list = []) {
    const mcpServers = {};
    for (const server of Array.isArray(list) ? list : []) {
      if (!server || typeof server.name !== 'string') continue;
      const pairs = (items) => Object.fromEntries((Array.isArray(items) ? items : []).filter((item) => item && typeof item.name === 'string').map((item) => [item.name, String(item.value ?? '')]));
      if (server.type === 'http' || server.type === 'sse' || server.url) mcpServers[server.name] = { type: server.type === 'sse' ? 'sse' : 'http', url: server.url, headers: pairs(server.headers) };
      else mcpServers[server.name] = { command: server.command, args: Array.isArray(server.args) ? server.args : [], env: pairs(server.env) };
    }
    return mcpServers;
  }

  async function openSession(params, restoreId = null) {
    const cwd = typeof params.cwd === 'string' && path.isAbsolute(params.cwd) ? params.cwd : null;
    if (!cwd) throw rpcError(-32602, 'cwd must be an absolute path.');
    const info = await stat(cwd).catch(() => null);
    if (!info || !info.isDirectory()) throw rpcError(-32602, 'cwd is not a directory: ' + cwd);
    const { createSession } = await load('agent');
    const { loadConfig } = await load('config');
    const config = await loadConfig({ env });
    if (!config.configured) throw rpcError(-32000, 'No model provider is configured. Run `oasis setup` in a terminal first, or set OASIS_PROTOCOL, OASIS_BASE_URL, OASIS_MODEL and the API key variable.');
    let restore = null;
    if (restoreId) {
      const { loadSession } = await load('sessions');
      restore = await loadSession(cwd, restoreId).catch((error) => { throw rpcError(-32002, 'Session not found: ' + error.message); });
    }
    let mcpServers = [];
    const specs = acpMcpServers(params.mcpServers);
    if (Object.keys(specs).length) {
      const { parseMcpServerEntries } = deps.mcpProject || await import('./mcp-project.mjs');
      const parsed = parseMcpServerEntries({ mcpServers: specs }, env, 'flag');
      for (const failure of parsed.failures || []) log('MCP server ' + failure.name + ' skipped: ' + failure.error);
      mcpServers = parsed.servers || [];
    }
    const session = await createSession({ root: cwd, config, restore, env, mcpServers, permissionMode: options.permissionMode || null });
    session.headless = true;
    session.acp = true;
    if (!session.sessionId) {
      try { const { saveSession } = await load('sessions'); session.sessionId = (await saveSession(session, { env })).id; } catch { session.sessionId = 'acp-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10); }
    }
    // Editors that offer fs/* get reads of unsaved buffers and writes that land in the open buffer.
    const fsCaps = clientCapabilities && clientCapabilities.fs || {};
    if (fsCaps.readTextFile || fsCaps.writeTextFile) {
      const sid = session.sessionId;
      const withTimeout = (promise, ms) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('client fs timed out')), ms).unref?.())]);
      session.clientFs = {
        // The last buffer text read per file, so a diff's "before" side matches what the editor showed.
        recentReads: new Map(),
        ...(fsCaps.readTextFile ? { readTextFile: async (file) => { const reply = await withTimeout(request('fs/read_text_file', { sessionId: sid, path: file }), 10000); const text = reply && typeof reply.content === 'string' ? reply.content : null; if (text !== null && text.length <= 1024 * 1024) session.clientFs.recentReads.set(file, text); return text; } } : {}),
        ...(fsCaps.writeTextFile ? { writeTextFile: async (file, content) => { await withTimeout(request('fs/write_text_file', { sessionId: sid, path: file, content }), 10000); } } : {})
      };
    }
    const entry = { session, root: cwd, controller: null, config, terminals: [], activeCallIds: null };
    // Editors that offer terminal/* can run commands in their own terminal panel (opt-in).
    const terminalOptIn = options.editorTerminal === true || /^(1|true|on|yes)$/i.test(String(env.OASIS_ACP_TERMINAL || '').trim());
    if (terminalOptIn && clientCapabilities && clientCapabilities.terminal === true) {
      session.clientTerminal = (spec) => runInEditorTerminal(entry, spec);
    }
    sessions.set(session.sessionId, entry);
    return entry;
  }

  async function runInEditorTerminal(entry, { command, args = [], cwd, env: extraEnv = [], timeoutSeconds = 120, signal } = {}) {
    const sessionId = entry.session.sessionId;
    const created = await request('terminal/create', { sessionId, command, args, cwd, env: extraEnv, outputByteLimit: TERMINAL_OUTPUT_LIMIT });
    const terminalId = created && typeof created.terminalId === 'string' ? created.terminalId : '';
    if (!terminalId) throw new Error('The editor did not return a terminal id.');
    entry.terminals.push(terminalId);
    const queue = entry.activeCallIds && entry.activeCallIds.get('run_command') || [];
    const toolCallId = queue[queue.length - 1];
    if (toolCallId) update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: 'in_progress', content: [{ type: 'terminal', terminalId }] });
    let timedOut = false; let cancelled = false; let timer = null; let onAbort = null;
    try {
      const stopped = new Promise((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(null); }, timeoutSeconds * 1000);
        timer.unref?.();
        onAbort = () => { cancelled = true; resolve(null); };
        if (signal) { if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true }); }
      });
      const exit = await Promise.race([request('terminal/wait_for_exit', { sessionId, terminalId }), stopped]);
      if (!exit) await request('terminal/kill', { sessionId, terminalId }).catch(() => {});
      const out = await request('terminal/output', { sessionId, terminalId }).catch(() => null);
      const status = (exit && typeof exit === 'object' ? exit : null) || (out && out.exitStatus) || {};
      return {
        exitCode: typeof status.exitCode === 'number' ? status.exitCode : null,
        signal: typeof status.signal === 'string' ? status.signal : null,
        stdout: out && typeof out.output === 'string' ? out.output : '',
        stderr: '',
        stdoutTruncated: Boolean(out && out.truncated),
        timedOut, cancelled, editorTerminal: terminalId,
        ...(timedOut ? { message: 'Stopped after ' + timeoutSeconds + ' seconds in the editor terminal.' } : {})
      };
    } catch (error) {
      const failure = new Error('Editor terminal failed: ' + String(error && error.message || error));
      failure.started = true;
      throw failure;
    } finally {
      clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async function releaseTerminals(entry) {
    const ids = entry.terminals.splice(0);
    for (const terminalId of ids) await request('terminal/release', { sessionId: entry.session.sessionId, terminalId }).catch(() => {});
  }

  function contextSize(entry) {
    try { return contextWindowSize(entry.session.config || {}, env) || 0; } catch { return 0; }
  }

  function modeState(entry) {
    const current = entry.session.permissions && entry.session.permissions.mode || 'default';
    return { currentModeId: MODE_INFO.some((mode) => mode.id === current) ? current : 'default', availableModes: MODE_INFO };
  }

  function setMode(entry, modeId) {
    if (typeof entry.session.permissions.setMode === 'function') entry.session.permissions.setMode(modeId);
    else entry.session.permissions.mode = modeId;
  }

  // The configured model first, then any models the settings allow
  // (availableModels), so an editor's model picker offers only allowed ones.
  function modelChoices(entry) {
    const current = entry.session.config && entry.session.config.model || '';
    const allowed = entry.session.availableModels || (entry.session.settings && entry.session.settings.availableModels) || [];
    return [...new Set([current, ...allowed].filter((item) => typeof item === 'string' && item && !item.includes('*')))];
  }

  function configOptions(entry) {
    const mode = modeState(entry);
    const list = [{ id: 'mode', name: 'Mode', category: 'mode', type: 'select', currentValue: mode.currentModeId, options: MODE_INFO.map((item) => ({ value: item.id, name: item.name, description: item.description })) }];
    const models = modelChoices(entry);
    if (models.length) list.push({ id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: entry.session.config.model || models[0], options: models.map((id) => ({ value: id, name: id })) });
    return list;
  }

  async function closeEntry(entry, { save = true } = {}) {
    if (entry.controller) entry.controller.abort();
    if (save) { try { const { saveSession } = await load('sessions'); await saveSession(entry.session, { env }); } catch {} }
    try { const { closeSession } = await load('agent'); if (closeSession) await closeSession(entry.session); } catch {}
    sessions.delete(entry.session.sessionId);
  }

  async function replay(entry) {
    for (const message of entry.session.messages || []) {
      if (!message || typeof message.content !== 'string' || !message.content) continue;
      if (message.role === 'user') update(entry.session.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: message.content } });
      else if (message.role === 'assistant') update(entry.session.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message.content } });
    }
  }

  async function prompt(params, requestSignal = null) {
    const entry = sessions.get(params.sessionId);
    if (!entry) throw rpcError(-32002, 'Unknown session ' + params.sessionId);
    if (entry.controller) throw rpcError(-32000, 'A prompt is already running in this session.');
    const sessionId = params.sessionId;
    const { runAgentTurn, runAgentPlan } = await load('agent');
    const built = promptFromBlocks(params.prompt, entry.root);
    let text = built.text;
    let images = built.images;
    try {
      const { expandFileMentions } = await load('mentions');
      if (typeof expandFileMentions === 'function') {
        const expanded = await expandFileMentions(entry.root, text, { images: true });
        text = expanded.text; if (expanded.images && expanded.images.length) images = images.concat(expanded.images);
      }
    } catch {}
    const controller = new AbortController();
    entry.controller = controller;
    // `$/cancel_request` for this prompt (the SDK aborts the request's signal)
    // stops the turn like session/cancel; the reply is stopReason "cancelled".
    if (requestSignal) { if (requestSignal.aborted) controller.abort(); else requestSignal.addEventListener('abort', () => controller.abort(), { once: true }); }
    const callIds = new Map();
    entry.activeCallIds = callIds;
    const before = new Map();
    let counter = 0;
    let streamed = '';
    const runner = entry.session.permissions && entry.session.permissions.mode === 'plan' && typeof runAgentPlan === 'function' ? runAgentPlan : runAgentTurn;
    const firstPrompt = !(entry.session.messages || []).some((message) => message && message.role === 'user');
    try {
      const turn = await runner(entry.session, text, {
        env,
        signal: controller.signal,
        ...(canElicitForm() ? { askUser: (question) => elicitAnswer(sessionId, question, { toolCallId: (callIds.get('ask_user_question') || []).at(-1), signal: controller.signal }) } : {}),
        onUsage: (usage) => {
          if (!usage || usage.subagent || usage.phase) return;
          const cost = Number(usage.costUsd);
          if (Number.isFinite(cost) && cost > 0 && usage.costKnown !== false) entry.costUsd = (entry.costUsd || 0) + cost;
          const used = Math.max(0, Math.round(Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0)));
          const size = contextSize(entry);
          if (used && size) update(sessionId, { sessionUpdate: 'usage_update', used, size, ...(entry.costUsd ? { cost: { amount: Math.round(entry.costUsd * 1e6) / 1e6, currency: 'USD' } } : {}) });
        },
        ...(images.length ? { images } : {}),
        onDelta: (accumulated) => {
          const value = String(accumulated || '');
          const delta = value.startsWith(streamed) ? value.slice(streamed.length) : value;
          streamed = value;
          if (delta) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: delta } });
        },
        onStreamRestart: () => { streamed = ''; },
        onText: (value) => {
          const textValue = String(value || '');
          if (!streamed && textValue) update(sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: textValue } });
          streamed = '';
        },
        onToolStart: ({ name, args, call, subagent }) => {
          const toolCallId = call && call.id ? String(call.id) : 'call-' + (++counter);
          const queue = callIds.get(name) || []; queue.push(toolCallId); callIds.set(name, queue);
          if (DIFF_TOOLS.has(name) && args && typeof args.path === 'string') {
            const file = path.resolve(entry.root, args.path);
            let oldText = null;
            try { const info = statSync(file); if (info.isFile() && info.size <= 1024 * 1024) oldText = readFileSync(file, 'utf8'); } catch {}
            if (entry.session.clientFs && entry.session.clientFs.recentReads) entry.session.clientFs.recentReads.delete(file);
            before.set(toolCallId, { file, oldText });
          }
          update(sessionId, { sessionUpdate: 'tool_call', toolCallId, title: (subagent ? '[' + subagent + '] ' : '') + toolTitle(name, args), kind: toolKind(name), status: 'in_progress', rawInput: args || {}, locations: toolLocations(entry.root, args) });
          if (name === 'todo_write' && args && Array.isArray(args.todos)) {
            update(sessionId, { sessionUpdate: 'plan', entries: args.todos.slice(0, 50).map((todo) => ({ content: String(todo.content || todo.activeForm || ''), status: ['pending', 'in_progress', 'completed'].includes(todo.status) ? todo.status : 'pending', priority: ['high', 'medium', 'low'].includes(todo.priority) ? todo.priority : 'medium' })) });
          }
        },
        onToolResult: ({ name, result }) => {
          const queue = callIds.get(name) || [];
          const toolCallId = queue.shift() || 'call-' + (++counter);
          const content = [{ type: 'content', content: { type: 'text', text: resultText(result).slice(0, 20000) } }];
          const prior = before.get(toolCallId);
          before.delete(toolCallId);
          if (prior && !isFailure(result)) {
            const buffered = entry.session.clientFs && entry.session.clientFs.recentReads && entry.session.clientFs.recentReads.get(prior.file);
            if (typeof buffered === 'string') prior.oldText = buffered;
            try {
              const newText = readFileSync(prior.file, 'utf8');
              if (newText !== prior.oldText && newText.length <= 1024 * 1024) content.unshift({ type: 'diff', path: prior.file, oldText: prior.oldText, newText });
            } catch {}
          }
          if (result && typeof result === 'object' && typeof result.editorTerminal === 'string') content.unshift({ type: 'terminal', terminalId: result.editorTerminal });
          update(sessionId, { sessionUpdate: 'tool_call_update', toolCallId, status: isFailure(result) ? 'failed' : 'completed', content, rawOutput: typeof result === 'object' && result ? { exitCode: result.exitCode } : undefined });
        },
        approval: async (message, _force = false, meta = {}) => {
          const toolName = meta && meta.tool || 'action';
          const queue = callIds.get(toolName) || [];
          const toolCallId = queue[queue.length - 1] || 'call-' + (++counter);
          const optionsList = [
            { optionId: 'allow_once', name: 'Allow', kind: 'allow_once' },
            ...(meta && meta.suggestion ? [{ optionId: 'allow_always', name: 'Always allow', kind: 'allow_always' }] : []),
            { optionId: 'reject_once', name: 'Reject', kind: 'reject_once' }
          ];
          let reply;
          try {
            reply = await request('session/request_permission', { sessionId, toolCall: { toolCallId, title: toolTitle(toolName, meta && meta.input || {}), kind: toolKind(toolName), status: 'pending', rawInput: meta && meta.input || {}, content: [{ type: 'content', content: { type: 'text', text: String(message).slice(0, 8000) } }] }, options: optionsList });
          } catch (error) { log('permission request failed: ' + error.message); return false; }
          const outcome = reply && reply.outcome;
          if (!outcome || outcome.outcome !== 'selected') return false;
          if (outcome.optionId === 'allow_always') return meta && meta.suggestion ? 'always' : true;
          return outcome.optionId === 'allow_once';
        }
      });
      try { const { saveSession } = await load('sessions'); await saveSession(entry.session, { env }); } catch {}
      if (firstPrompt) {
        const title = (entry.session.name || built.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        if (title) update(sessionId, { sessionUpdate: 'session_info_update', title, updatedAt: new Date().toISOString() });
      }
      if (controller.signal.aborted) return { stopReason: 'cancelled' };
      if (turn && turn.limitReached) return { stopReason: 'max_turn_requests' };
      return { stopReason: 'end_turn' };
    } catch (error) {
      if (controller.signal.aborted) return { stopReason: 'cancelled' };
      throw rpcError(-32603, String(error && error.message || error));
    } finally { entry.controller = null; entry.activeCallIds = null; await releaseTerminals(entry); }
  }

  async function handle(method, params = {}, { signal = null } = {}) {
    switch (method) {
      case 'initialize':
        clientCapabilities = params.clientCapabilities || {};
        return {
          protocolVersion: ACP_PROTOCOL_VERSION,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true, audio: false, embeddedContext: true }, mcpCapabilities: { http: true, sse: true }, sessionCapabilities: { list: {}, resume: {}, close: {}, delete: {} } },
          agentInfo: { name: 'oasis', title: 'OASIS', version: options.version || '' },
          authMethods: []
        };
      case 'authenticate':
      case 'logout':
        return {};
      case 'session/new': {
        const entry = await openSession(params);
        return { sessionId: entry.session.sessionId, modes: modeState(entry), configOptions: configOptions(entry) };
      }
      case 'session/load':
      case 'session/resume': {
        if (typeof params.sessionId !== 'string') throw rpcError(-32602, 'sessionId is required.');
        // An already open session is reused instead of opening a second copy
        // that would race the first one when both save.
        const open = sessions.get(params.sessionId);
        if (open && open.controller) throw rpcError(-32000, 'That session has a prompt running.');
        const entry = open && path.resolve(open.root) === path.resolve(String(params.cwd || '')) ? open : await openSession(params, params.sessionId);
        // session/load replays the conversation; session/resume does not.
        if (method === 'session/load') await replay(entry);
        return { modes: modeState(entry), configOptions: configOptions(entry) };
      }
      case 'session/list': {
        const cwd = typeof params.cwd === 'string' && params.cwd ? params.cwd : (options.cwd || process.cwd());
        if (!path.isAbsolute(cwd)) throw rpcError(-32602, 'cwd must be an absolute path.');
        const { listSessions } = await load('sessions');
        const all = (await listSessions(cwd, { env }).catch(() => [])).filter((item) => !item.archived);
        const start = Math.max(0, Number.parseInt(params.cursor || '0', 10) || 0);
        const page = all.slice(start, start + LIST_PAGE);
        return {
          sessions: page.map((item) => ({ sessionId: item.id, cwd, title: item.title || null, updatedAt: item.updatedAt || null })),
          nextCursor: start + LIST_PAGE < all.length ? String(start + LIST_PAGE) : null
        };
      }
      case 'session/close': {
        const entry = sessions.get(params.sessionId);
        if (!entry) throw rpcError(-32002, 'Unknown session ' + params.sessionId);
        await closeEntry(entry);
        return {};
      }
      case 'session/delete': {
        if (typeof params.sessionId !== 'string' || !params.sessionId) throw rpcError(-32602, 'sessionId is required.');
        const entry = sessions.get(params.sessionId);
        if (entry && entry.controller) throw rpcError(-32000, 'Cancel the running prompt before deleting the session.');
        const root = entry ? entry.root : (typeof params.cwd === 'string' && path.isAbsolute(params.cwd) ? params.cwd : (options.cwd || process.cwd()));
        if (entry) await closeEntry(entry, { save: false });
        const { deleteSession } = await load('sessions');
        try { await deleteSession(root, params.sessionId, { env }); }
        catch (error) { throw rpcError(-32002, 'Session not found: ' + String(error && error.message || error)); }
        return {};
      }
      case 'session/set_config_option': {
        const entry = sessions.get(params.sessionId);
        if (!entry) throw rpcError(-32002, 'Unknown session ' + params.sessionId);
        const value = params.value;
        if (params.configId === 'mode') {
          if (!MODE_INFO.some((mode) => mode.id === value)) throw rpcError(-32602, 'Unknown mode ' + value);
          setMode(entry, value);
          update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: value });
        } else if (params.configId === 'model') {
          const choices = modelChoices(entry);
          if (typeof value !== 'string' || !choices.includes(value)) throw rpcError(-32602, 'Unknown model ' + value + '. Allowed: ' + choices.join(', '));
          if ((entry.session.config && entry.session.config.model) !== value) {
            const switched = await switchSessionModel(entry.session, { to: value, requested: value, source: 'sdk', env });
            if (!switched.ok) throw rpcError(-32000, switched.reason);
          }
        } else throw rpcError(-32602, 'Unknown config option ' + params.configId);
        return { configOptions: configOptions(entry) };
      }
      case 'session/prompt':
        return prompt(params, signal);
      case 'session/set_mode': {
        const entry = sessions.get(params.sessionId);
        if (!entry) throw rpcError(-32002, 'Unknown session ' + params.sessionId);
        if (!MODE_INFO.some((mode) => mode.id === params.modeId)) throw rpcError(-32602, 'Unknown mode ' + params.modeId);
        setMode(entry, params.modeId);
        update(params.sessionId, { sessionUpdate: 'current_mode_update', currentModeId: params.modeId });
        update(params.sessionId, { sessionUpdate: 'config_option_update', configOptions: configOptions(entry) });
        return {};
      }
      case 'session/cancel': {
        const entry = sessions.get(params.sessionId);
        if (entry && entry.controller) entry.controller.abort();
        return null;
      }
      default:
        throw rpcError(-32601, 'Method not found: ' + method);
    }
  }

  const app = acpAgent({ name: 'oasis' });
  const requests = [
    [methods.agent.initialize, 'initialize'], [methods.agent.authenticate, 'authenticate'],
    [methods.agent.session.new, 'session/new'], [methods.agent.session.load, 'session/load'],
    [methods.agent.session.prompt, 'session/prompt'], [methods.agent.session.setMode, 'session/set_mode'],
    [methods.agent.logout, 'logout'], [methods.agent.session.list, 'session/list'], [methods.agent.session.resume, 'session/resume'],
    [methods.agent.session.close, 'session/close'], [methods.agent.session.delete, 'session/delete'],
    [methods.agent.session.setConfigOption, 'session/set_config_option']
  ];
  for (const [method, name] of requests) app.onRequest(method, async ({ params, signal }) => { const result = await handle(name, params || {}, { signal }); return result === undefined ? null : result; });
  app.onNotification(methods.agent.session.cancel, async ({ params }) => { await handle('session/cancel', params || {}); });

  function connect(stream) {
    connection = app.connect(stream);
    connection.closed.then(() => close(), () => close());
    return connection;
  }

  // In-process transport for embedding and tests: receive(line) feeds one
  // ndjson line, replies go to options.write.
  let feed = null;
  function ensureLineTransport() {
    if (feed) return;
    const encoder = new TextEncoder();
    const input = new ReadableStream({ start(controller) { feed = controller; } });
    const output = new WritableStream({ write(chunk) { const text = new TextDecoder().decode(chunk); for (const line of text.split('\n')) if (line.trim()) write(line + '\n'); } });
    connect(ndJsonStream(output, input));
    feed.encoder = encoder;
  }
  async function receive(line) {
    ensureLineTransport();
    feed.enqueue(feed.encoder.encode(String(line || '') + '\n'));
    // Let the SDK parse, dispatch and reply before returning.
    await new Promise((resolve) => setImmediate(resolve));
  }

  let closing = null;
  function close() {
    if (closing) return closing;
    closing = (async () => {
      for (const entry of sessions.values()) {
        if (entry.controller) entry.controller.abort();
        try { const { closeSession } = await load('agent'); if (closeSession) await closeSession(entry.session); } catch {}
      }
      sessions.clear();
      try { connection && connection.close(); } catch {}
    })();
    return closing;
  }

  return { connect, receive, close, sessions, get clientCapabilities() { return clientCapabilities; } };
}

export async function serveAcp(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const server = createAcpServer(options);
  // Requests are handled concurrently by the SDK, so a long session/prompt does
  // not block the permission replies and cancel notifications that arrive meanwhile.
  const connection = server.connect(ndJsonStream(Writable.toWeb(output), Readable.toWeb(input)));
  await connection.closed.catch((error) => process.stderr.write('[oasis acp] ' + error.message + '\n'));
  await server.close();
}
