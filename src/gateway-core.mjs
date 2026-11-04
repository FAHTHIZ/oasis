// Shared chat core for the messaging gateways (Discord, Slack). A platform
// adapter supplies send(chatKey, text, { approval }) and optionally typing(chatKey);
// the core keeps one saved session per chat, runs turns, routes approval
// answers, and handles the chat commands /new, /stop, /status, /mode and /help
// (also accepted with a "!" prefix, since Slack reserves "/" for its own commands).
import path from 'node:path';

export const APPROVAL_TIMEOUT_MS = 10 * 60000;
export const MODES = ['default', 'acceptEdits', 'plan', 'auto'];

export function parseIdList(value) {
  return new Set(String(value || '').split(/[\s,]+/).map((item) => item.trim()).filter((item) => /^[A-Za-z0-9_-]{1,40}$/.test(item)));
}

export function chunkText(text, size) {
  const source = String(text || '').trim() || '(empty reply)';
  const parts = [];
  let rest = source;
  while (rest.length > size) {
    let cut = rest.lastIndexOf('\n', size);
    if (cut < size / 2) cut = size;
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest) parts.push(rest);
  return parts;
}

export function createChatCore(options = {}) {
  const env = options.env || process.env;
  const root = path.resolve(options.root || process.cwd());
  const deps = options.deps || {};
  const log = options.log || ((text) => process.stderr.write('[oasis gateway] ' + text + '\n'));
  const send = options.send;
  const typing = options.typing || (async () => {});
  const timeoutMs = options.approvalTimeoutMs || APPROVAL_TIMEOUT_MS;
  const chats = new Map();
  const approvals = new Map();
  let approvalCounter = 0;

  async function chatState(chatKey) {
    if (chats.has(chatKey)) return chats.get(chatKey);
    const { createSession } = deps.agent || await import('./agent.mjs');
    const { loadConfig } = deps.config || await import('./config.mjs');
    const config = options.config || await loadConfig({ env });
    if (config.configured === false) throw new Error('No model provider is configured. Run `oasis setup` first.');
    const session = await createSession({ root, config, env, permissionMode: options.permissionMode || null });
    session.headless = true;
    const state = { session, controller: null };
    chats.set(chatKey, state);
    return state;
  }

  async function runPrompt(chatKey, text) {
    const state = await chatState(chatKey);
    if (state.controller) { await send(chatKey, 'Still working on the previous request. Send /stop to cancel it.'); return; }
    const { runAgentTurn } = deps.agent || await import('./agent.mjs');
    const controller = new AbortController();
    state.controller = controller;
    Promise.resolve().then(() => typing(chatKey)).catch(() => {});
    const tools = [];
    try {
      const turn = await runAgentTurn(state.session, text, {
        env,
        signal: controller.signal,
        onToolStart: ({ name }) => { tools.push(name); },
        approval: (message, _force = false, meta = {}) => new Promise((resolve) => {
          const id = String(++approvalCounter);
          const canAlways = Boolean(meta && meta.suggestion);
          const timer = setTimeout(() => { approvals.delete(id); resolve(false); send(chatKey, 'Approval ' + id + ' timed out and was rejected.').catch(() => {}); }, timeoutMs);
          approvals.set(id, { chatKey, canAlways, resolve: (value) => { clearTimeout(timer); approvals.delete(id); resolve(value); } });
          send(chatKey, 'Approval needed:\n' + String(message).slice(0, 1800), { approval: { id, canAlways } }).catch((error) => { log(error.message); const waiter = approvals.get(id); if (waiter) waiter.resolve(false); });
        })
      });
      try { const { saveSession } = deps.sessions || await import('./sessions.mjs'); await saveSession(state.session, { env }); } catch {}
      if (controller.signal.aborted) await send(chatKey, 'Stopped.');
      else await send(chatKey, (turn && turn.text ? turn.text : 'Done.') + (tools.length ? '\n\n(' + tools.length + ' tool call' + (tools.length === 1 ? '' : 's') + ')' : ''));
    } catch (error) {
      await send(chatKey, controller.signal.aborted ? 'Stopped.' : 'Error: ' + String(error && error.message || error).slice(0, 1000));
    } finally {
      state.controller = null;
      for (const waiter of [...approvals.values()]) if (waiter.chatKey === chatKey) waiter.resolve(false);
    }
  }

  async function command(chatKey, text) {
    const [name, ...args] = text.trim().split(/\s+/);
    const cmd = name.replace(/@.*$/, '').replace(/^!/, '/').toLowerCase();
    if (cmd === '/start' || cmd === '/help') { await send(chatKey, 'OASIS agent for ' + root + '.\nSend a message to give it a task.\n/new (or !new) starts a fresh session, /stop cancels the running task, /status shows the session, /mode default|acceptEdits|plan|auto changes approvals.'); return true; }
    if (cmd === '/new') {
      const state = chats.get(chatKey);
      if (state && state.controller) state.controller.abort();
      chats.delete(chatKey);
      await send(chatKey, 'Started a fresh session.');
      return true;
    }
    if (cmd === '/stop') {
      const state = chats.get(chatKey);
      if (state && state.controller) { state.controller.abort(); await send(chatKey, 'Cancelling…'); } else await send(chatKey, 'Nothing is running.');
      return true;
    }
    if (cmd === '/status') {
      const state = chats.get(chatKey);
      await send(chatKey, state ? 'Workspace: ' + root + '\nModel: ' + (state.session.config && state.session.config.model) + '\nMode: ' + (state.session.permissions && state.session.permissions.mode) + '\nMessages: ' + state.session.messages.length + '\nRunning: ' + (state.controller ? 'yes' : 'no') : 'No session yet. Send a task to start one.');
      return true;
    }
    if (cmd === '/mode') {
      const mode = args[0];
      if (!MODES.includes(mode)) { await send(chatKey, 'Usage: /mode default|acceptEdits|plan|auto'); return true; }
      const state = await chatState(chatKey);
      if (typeof state.session.permissions.setMode === 'function') state.session.permissions.setMode(mode); else state.session.permissions.mode = mode;
      await send(chatKey, 'Mode set to ' + mode + '.');
      return true;
    }
    return false;
  }

  async function handleText(chatKey, text) {
    const body = String(text || '').trim();
    if (!body) return;
    if (/^[/!]/.test(body) && await command(chatKey, body)) return;
    runPrompt(chatKey, body).catch((error) => log(error.message));
  }

  /** kind: 'allow' | 'always' | 'reject'. Returns false if nothing was pending for this chat. */
  function answer(chatKey, id, kind) {
    const waiter = approvals.get(String(id));
    if (!waiter || waiter.chatKey !== chatKey) return false;
    waiter.resolve(kind === 'always' && waiter.canAlways ? 'always' : kind === 'allow' || kind === 'always');
    return true;
  }

  function stop() {
    for (const state of chats.values()) if (state.controller) state.controller.abort();
    for (const waiter of [...approvals.values()]) waiter.resolve(false);
  }

  return { handleText, answer, stop, chats, approvals, root };
}

/** Reconnect loop for WebSocket gateways: connect() resolves when the socket closes. */
export async function reconnectLoop(connect, { log, isStopped }) {
  let backoff = 1000;
  while (!isStopped()) {
    const started = Date.now();
    try { await connect(); } catch (error) { log(String(error && error.message || error)); }
    if (isStopped()) break;
    if (Date.now() - started > 60000) backoff = 1000;
    log('disconnected; reconnecting in ' + Math.round(backoff / 1000) + 's');
    await new Promise((resolve) => setTimeout(resolve, backoff));
    backoff = Math.min(60000, backoff * 2);
  }
}
