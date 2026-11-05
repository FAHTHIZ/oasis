// Runtime engine. When the app is opened from `oasis web` or the desktop app,
// the agent runs on this computer (real shell, real files, git, MCP) instead
// of in the browser. The page talks to it over the token-protected local API;
// everything else in the app (chat, plugins, approvals, files panel) stays the
// same, so there is one interface whether OASIS runs in a tab or on a laptop.

const TOKEN_KEY = 'oasis.web.token';
const TOKEN_RE = /(?:^#|[#&?])token=([A-Za-z0-9_-]{16,200})/;

/** Read the runtime token from the address (#token=…) or this tab's storage. */
export function runtimeToken(win = globalThis) {
  try {
    const hash = String(win.location && win.location.hash || '');
    const match = hash.match(TOKEN_RE);
    if (match) {
      try { win.sessionStorage.setItem(TOKEN_KEY, match[1]); } catch { /* storage blocked */ }
      try { win.history.replaceState(null, '', win.location.pathname + win.location.search); } catch { /* sandboxed */ }
      return match[1];
    }
    return win.sessionStorage.getItem(TOKEN_KEY) || '';
  } catch { return ''; }
}

/** Accept a pasted runtime link (http://host:port/app/#token=…) or a bare token. */
export function tokenFromPaste(text) {
  const value = String(text || '').trim();
  const match = value.match(TOKEN_RE);
  if (match) return match[1];
  return /^[A-Za-z0-9_-]{32,200}$/.test(value) && !/^(sk|hf|gsk|xai|AIza|ghp|github_pat|pplx|nvapi|csk|r8|fw)[-_]/i.test(value) ? value : '';
}

export function saveRuntimeToken(token, win = globalThis) {
  try { win.sessionStorage.setItem(TOKEN_KEY, token); } catch { /* storage blocked */ }
}

export class RuntimeClient {
  constructor({ token = '', origin = '', fetchImpl = globalThis.fetch.bind(globalThis) } = {}) {
    this.token = token;
    this.origin = origin;
    this.fetch = fetchImpl;
  }

  async api(path, { method = 'GET', body, signal } = {}) {
    const response = await this.fetch(this.origin + path, {
      method,
      signal,
      headers: { authorization: 'Bearer ' + this.token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    let data = {};
    try { data = await response.json(); } catch { /* empty body */ }
    if (!response.ok) throw Object.assign(new Error(data.error || 'OASIS runtime error ' + response.status), { status: response.status, data });
    return data;
  }
}

/**
 * Is this page served by a local OASIS runtime? Returns
 *   { available: false } for the plain web app,
 *   { available: true, needsToken: true } when the runtime is there but this tab has no token,
 *   { available: true, client, status } when connected.
 */
export async function detectRuntime({ win = globalThis, fetchImpl = globalThis.fetch && globalThis.fetch.bind(globalThis) } = {}) {
  const location = win.location || {};
  if (!/^https?:$/.test(location.protocol || '') || !/^\/app(\/|$)/.test(location.pathname || '')) return { available: false };
  const token = runtimeToken(win);
  const client = new RuntimeClient({ token, fetchImpl });
  try {
    const status = await client.api('/api/status');
    return { available: true, client, status };
  } catch (error) {
    if (error.status === 401) return { available: true, needsToken: true };
    return { available: false };
  }
}

const APP_TO_RUNTIME_MODE = { ask: 'default', edits: 'acceptEdits', auto: 'auto' };

function pause(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function toolArgs(data) {
  const args = data && data.args && typeof data.args === 'object' ? { ...data.args } : {};
  if (data && data.label && !args.summary) args.summary = data.label;
  return args;
}

/**
 * Same interface as the in-browser Agent (busy, send, stop, reset, load), so
 * the chat UI does not care where the agent runs. Events use the app's names.
 */
export class RuntimeAgent {
  constructor({ client, onEvent = () => {}, approve = async () => false, ask = async () => '', getMode = () => 'ask', getPlugins = () => [], pollMs = 350 } = {}) {
    this.client = client;
    this.onEvent = onEvent;
    this.approve = approve;
    this.ask = ask;
    this.getMode = getMode;
    this.getPlugins = getPlugins;
    this.pollMs = pollMs;
    this.busy = false;
    this.messages = [];
    this.todos = [];
    this.usage = { input: 0, output: 0 };
    this.sessionId = '';
    this.jobId = '';
    this.controller = null;
  }

  emit(type, data = {}) { try { this.onEvent({ type, ...data }); } catch { /* UI errors never stop the agent */ } }

  reset() { this.sessionId = ''; this.messages = []; this.todos = []; this.usage = { input: 0, output: 0 }; }

  load(state) {
    if (state && typeof state === 'object' && !Array.isArray(state) && typeof state.sessionId === 'string') this.sessionId = state.sessionId;
    this.messages = [];
  }

  snapshot() { return { sessionId: this.sessionId }; }

  stop() {
    if (this.jobId) this.client.api('/api/jobs/' + this.jobId + '/cancel', { method: 'POST', body: {} }).catch(() => {});
    if (this.controller) this.controller.abort();
  }

  async send(text, { plugins = [] } = {}) {
    if (this.busy) throw new Error('OASIS is still working on the last message.');
    let message = String(text || '').trim();
    if (!message) return;
    this.busy = true;
    this.controller = new AbortController();
    const signal = this.controller.signal;
    this.emit('user', { content: message });
    const names = plugins.map((plugin) => plugin && plugin.name).filter(Boolean);
    const skills = plugins.flatMap((plugin) => plugin && Array.isArray(plugin.skills) ? plugin.skills : []);
    if (names.length) message += '\n\n(Use the ' + names.join(', ') + ' plugin' + (names.length > 1 ? 's' : '') + (skills.length ? ': skills ' + skills.join(', ') : '') + '.)';
    if (message.length > 12000) message = message.slice(0, 12000);
    // The app renders one bubble per model step: thinking, streamed text,
    // then that step's tool cards. Runtime events are mapped onto that shape.
    let stepText = '';
    let stepHasTools = false;
    let stepTextFinal = false;
    const newStepIfNeeded = () => {
      if (!stepHasTools && !stepTextFinal) return;
      if (!stepHasTools) this.emit('assistant', { content: stepText, toolCalls: [] });
      this.emit('thinking');
      stepText = ''; stepHasTools = false; stepTextFinal = false;
    };
    const addText = (text, full) => {
      if (full) {
        if (stepTextFinal || stepHasTools) newStepIfNeeded();
        const rest = text.startsWith(stepText) ? text.slice(stepText.length) : text;
        if (!text.startsWith(stepText)) stepText = '';
        if (rest) { stepText += rest; this.emit('delta', { delta: rest }); }
        stepTextFinal = true;
      } else {
        if (stepHasTools || stepTextFinal) newStepIfNeeded();
        stepText += text;
        this.emit('delta', { delta: text });
      }
    };
    const finish = (finalText) => {
      if (stepHasTools) {
        if (finalText) { this.emit('thinking'); this.emit('assistant', { content: finalText, toolCalls: [] }); }
      } else this.emit('assistant', { content: stepText || finalText || '', toolCalls: [] });
      stepText = ''; stepHasTools = false; stepTextFinal = false;
    };
    try {
      this.emit('thinking');
      const started = await this.client.api('/api/chat', {
        method: 'POST',
        signal,
        body: { message, ...(this.sessionId ? { sessionId: this.sessionId } : {}), permissionMode: APP_TO_RUNTIME_MODE[this.getMode()] || 'default' }
      });
      this.jobId = started.jobId;
      if (started.sessionId) this.sessionId = started.sessionId;
      let after = 0;
      let done = false;
      let idle = 0;
      while (!done) {
        if (signal.aborted) { this.emit('stopped'); break; }
        let job;
        try { job = await this.client.api('/api/jobs/' + this.jobId + '?after=' + after, { signal }); }
        catch (error) {
          if (signal.aborted) { this.emit('stopped'); break; }
          if (error.status === 404) throw new Error('The task ended on this computer before the page could follow it.');
          idle++;
          if (idle > 20) throw new Error('Lost the connection to OASIS on this computer.');
          await pause(1000, signal);
          continue;
        }
        idle = 0;
        for (const event of job.events || []) {
          after = Math.max(after, event.id);
          const data = event.data || {};
          switch (event.type) {
            case 'started': if (data.sessionId) this.sessionId = data.sessionId; break;
            case 'assistant_delta': if (data.text) addText(String(data.text), false); break;
            case 'assistant_text': if (data.text) addText(String(data.text), true); break;
            case 'command_output': if (data.text) addText(String(data.text), true); break;
            case 'stream_restarted': stepText = ''; this.emit('retry', { attempt: data.attempt || 1 }); break;
            case 'tool_start': {
              const id = data.callId || 'call_' + event.id;
              const call = { id, name: data.name, args: toolArgs(data) };
              if (!stepHasTools) { this.emit('assistant', { content: stepText, toolCalls: [call] }); stepHasTools = true; }
              this.emit('tool_start', { id, name: data.name, args: call.args });
              break;
            }
            case 'tool_result': {
              const ok = !/^(error|failed|denied|blocked)$/i.test(String(data.status || ''));
              const content = [data.result, data.warning].filter(Boolean).join('\n');
              this.emit('tool_result', { id: data.callId || '', name: data.name, ok, content: String(content || data.label || '').slice(0, 4000) });
              break;
            }
            case 'approval_required': {
              const value = await this.approve({ name: data.tool || 'runtime', args: { prompt: data.prompt, diff: data.diff, suggestion: data.suggestion, risky: data.risky }, runtime: true });
              const approved = value === 'always' || value === true;
              await this.client.api('/api/jobs/' + this.jobId + '/approval', { method: 'POST', body: { approvalId: data.approvalId, approved, always: value === 'always' } }).catch(() => {});
              break;
            }
            case 'question': {
              const answer = await this.ask(data);
              await this.client.api('/api/jobs/' + this.jobId + '/answer', { method: 'POST', body: { questionId: data.questionId, answer: String(answer || '') } }).catch(() => {});
              break;
            }
            case 'elicitation':
              // Forms from tool servers are answered in the terminal for now.
              await this.client.api('/api/jobs/' + this.jobId + '/elicitation', { method: 'POST', body: { elicitationId: data.elicitationId, action: 'decline' } }).catch(() => {});
              break;
            case 'usage': {
              const input = Number(data.inputTokens || data.input_tokens || 0);
              const output = Number(data.outputTokens || data.output_tokens || 0);
              this.usage.input += input; this.usage.output += output;
              this.emit('usage', { usage: { ...this.usage } });
              break;
            }
            case 'compaction_completed': this.emit('compacted', { mode: data.usedModelSummary ? 'summary' : 'trim' }); break;
            case 'completed':
              if (data.sessionId) this.sessionId = data.sessionId;
              finish(stepHasTools && !data.command ? String(data.text || '') : '');
              done = true;
              break;
            case 'failed': if (stepText || stepHasTools) finish(''); this.emit('error', { message: data.message || 'The task failed.' }); done = true; break;
            case 'cancelled': if (data.sessionId) this.sessionId = data.sessionId; this.emit('stopped'); done = true; break;
            default: break;
          }
          if (done) break;
        }
        if (!done && ['completed', 'error', 'cancelled'].includes(job.status)) {
          if (job.status === 'completed') finish(stepHasTools ? String(job.result && job.result.text || '') : '');
          if (job.status === 'error') this.emit('error', { message: job.error || 'The task failed.' });
          if (job.status === 'cancelled') this.emit('stopped');
          done = true;
        }
        if (!done) await pause(this.pollMs, signal);
      }
    } catch (error) {
      if (signal.aborted) this.emit('stopped');
      else this.emit('error', { message: error.message || String(error) });
    } finally {
      this.busy = false;
      this.jobId = '';
      this.controller = null;
      this.emit('done');
    }
  }
}

/** Read-only view of the runtime's folder for the Files panel. */
export class RuntimeWorkspace {
  constructor(client, status = {}) {
    this.client = client;
    this.readOnly = true;
    this.project = { id: 'runtime:' + (status.workspacePath || status.workspaceName || 'local'), name: status.workspaceName || 'This folder', source: { type: 'runtime', path: status.workspacePath || '' }, updatedAt: Date.now() };
    this.cache = null;
    this.diffCache = null;
  }
  async load() { return new Map(); }
  async paths() {
    const data = await this.client.api('/api/workspace/files');
    this.cache = data.files || [];
    return this.cache;
  }
  async exists(path) { return (this.cache || (await this.paths())).includes(path); }
  async read(path) { const data = await this.client.api('/api/workspace/file?path=' + encodeURIComponent(path)); return String(data.content || ''); }
  async diff() {
    this.diffCache = await this.client.api('/api/workspace/diff').catch(() => ({ files: [], diff: '' }));
    return this.diffCache;
  }
  async changes() {
    const data = await this.diff();
    // OASIS's own sessions and checkpoints are not the user's changes.
    return (data.files || []).filter((file) => !/^\.oasis(\/|$)/.test(file.path)).map((file) => ({ path: file.path, status: /^(A|\?|added|untracked)/i.test(String(file.status || '')) ? 'added' : /^(D|deleted)/i.test(String(file.status || '')) ? 'deleted' : 'modified' }));
  }
  /** Unified diff lines for one file, from the last diff fetch. */
  fileDiff(path) {
    const text = String(this.diffCache && this.diffCache.diff || '');
    const lines = [];
    let inFile = false;
    for (const line of text.split('\n')) {
      if (line.startsWith('diff --git ')) { inFile = line.endsWith(' b/' + path); continue; }
      if (!inFile || /^(index |--- |\+\+\+ |new file|deleted file|similarity|rename )/.test(line)) continue;
      if (line.startsWith('@@')) lines.push({ type: 'note', text: line });
      else if (line.startsWith('+')) lines.push({ type: 'add', text: line.slice(1) });
      else if (line.startsWith('-')) lines.push({ type: 'del', text: line.slice(1) });
      else lines.push({ type: 'same', text: line.slice(1) });
    }
    return lines;
  }
}
