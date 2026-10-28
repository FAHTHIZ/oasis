// Runs `oasis -p` in stream-json mode for the chat panel and translates its events.
// No VS Code APIs here, so it is testable with plain Node.
'use strict';
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');

const BASE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--include-partial-messages', '--permission-prompt-tool', 'stdio'];

function splitCommand(command) {
  // "node /path/to/cli.mjs" or "oasis": the first word is the program, the rest are arguments.
  const parts = String(command || 'oasis').match(/"[^"]*"|'[^']*'|\S+/g) || ['oasis'];
  return parts.map((part) => part.replace(/^(["'])(.*)\1$/, '$2'));
}

class OasisChatProcess extends EventEmitter {
  constructor({ command = 'oasis', cwd, env = {}, extraArgs = [], spawnImpl = spawn } = {}) {
    super();
    this.command = command;
    this.cwd = cwd;
    this.env = env;
    this.extraArgs = extraArgs;
    this.spawnImpl = spawnImpl;
    this.child = null;
    this.buffer = '';
    this.busy = false;
    this.sessionId = null;
    this.pending = new Map(); // request_id -> request
    this.nextId = 1;
  }

  start() {
    if (this.child) return;
    const [program, ...prefix] = splitCommand(this.command);
    const child = this.spawnImpl(program, [...prefix, ...BASE_ARGS, ...this.extraArgs], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env, OASIS_PLAIN_OUTPUT: '1', NO_COLOR: '1' },
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this._onData(chunk));
    child.stderr.on('data', (chunk) => this.emit('stderr', chunk));
    child.on('error', (error) => { this.emit('ui', { kind: 'error', text: 'Could not start OASIS (' + this.command + '): ' + error.message }); this._exit(); });
    child.on('close', (code) => { if (this.child === child) { this.emit('ui', { kind: 'exit', code }); this._exit(); } });
  }

  _exit() {
    this.child = null;
    this.busy = false;
    this.pending.clear();
    this.emit('ui', { kind: 'busy', busy: false });
  }

  _onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { this.emit('stderr', line + '\n'); continue; }
      for (const ui of translateEvent(event, this)) this.emit('ui', ui);
    }
  }

  _write(message) {
    if (!this.child || !this.child.stdin.writable) return false;
    this.child.stdin.write(JSON.stringify(message) + '\n');
    return true;
  }

  send(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    this.start();
    this.busy = true;
    this.emit('ui', { kind: 'busy', busy: true });
    return this._write({ type: 'user', message: { role: 'user', content: value } });
  }

  respond(requestId, behavior, { always = false, message = '' } = {}) {
    if (!this.pending.has(requestId)) return false;
    this.pending.delete(requestId);
    return this._write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response: { behavior, ...(always ? { always: true } : {}), ...(message ? { message } : {}) } } });
  }

  interrupt() {
    if (!this.busy) return false;
    return this._write({ type: 'control_request', request_id: 'ui-' + (this.nextId++), request: { subtype: 'interrupt' } });
  }

  stop() {
    const child = this.child;
    this._exit();
    if (child) { try { child.stdin.end(); } catch {} try { child.kill(); } catch {} }
  }
}

function toolSummary(name, input = {}) {
  const value = input.path || input.file_path || input.command || input.pattern || input.query || input.url || input.description || '';
  return String(name || 'tool') + (value ? ' · ' + String(value).split('\n')[0].slice(0, 120) : '');
}

/** Converts one stream-json event into UI messages for the webview. */
function translateEvent(event, state = {}) {
  const out = [];
  if (!event || typeof event !== 'object') return out;
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') { state.sessionId = event.session_id || null; out.push({ kind: 'init', model: event.model, cwd: event.cwd, permissionMode: event.permission_mode }); }
      else if (event.subtype === 'ide_selection') out.push({ kind: 'note', text: event.label });
      else if (event.subtype === 'interrupted') out.push({ kind: 'note', text: 'Interrupted.' });
      else if (event.subtype === 'permission' && event.via === 'ide_diff') out.push({ kind: 'note', text: (event.allowed ? 'Accepted' : 'Rejected') + ' ' + (event.tool || 'edit') + ' in the diff view.' });
      break;
    case 'stream_event': {
      const delta = event.event && event.event.delta;
      if (delta && delta.type === 'text_delta' && delta.text) out.push({ kind: 'delta', text: delta.text });
      break;
    }
    case 'assistant':
      out.push({ kind: 'assistant', text: String(event.text || (event.message && Array.isArray(event.message.content) ? event.message.content.map((block) => block.text || '').join('') : '')) });
      break;
    case 'tool_use':
      out.push({ kind: 'tool', name: event.name, summary: toolSummary(event.name, event.input), subagent: event.subagent || null });
      break;
    case 'tool_result':
      out.push({ kind: 'toolResult', name: event.name, isError: Boolean(event.is_error), preview: typeof event.content === 'string' ? event.content.slice(0, 600) : JSON.stringify(event.content || '').slice(0, 600) });
      break;
    case 'control_request': {
      const request = event.request || {};
      if (request.subtype === 'can_use_tool') {
        if (state.pending) state.pending.set(event.request_id, request);
        out.push({ kind: 'permission', requestId: event.request_id, tool: request.tool_name, message: String(request.message || ''), canAlways: Array.isArray(request.permission_suggestions) && request.permission_suggestions.length > 0, suggestion: Array.isArray(request.permission_suggestions) ? request.permission_suggestions[0] : null });
      }
      break;
    }
    case 'result':
      if (event.subtype === 'turn' || event.subtype === 'success' || event.is_error) {
        state.busy = false;
        out.push({ kind: 'turnEnd', isError: Boolean(event.is_error), text: event.is_error ? String(event.result || '') : '', costUsd: event.total_cost_usd });
        out.push({ kind: 'busy', busy: false });
      }
      break;
    default: break;
  }
  return out;
}

module.exports = { OasisChatProcess, translateEvent, splitCommand, BASE_ARGS };
