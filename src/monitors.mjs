// Monitors and background-event notifications (Claude Code's Monitor tool).
//
// A monitor is a background process (or a WebSocket) whose stdout lines (or
// messages) are delivered to the agent as events. Events land in the session
// inbox and are added to the conversation between steps of a running turn. When
// the session is idle, `session.onBackgroundEvent` lets the interactive CLI (or
// the headless runner) start a turn so the agent reacts right away.
//
// Background commands started with run_command run_in_background=true also send
// one notice when they exit, so the agent no longer has to poll for completion.
//
// Plugins declare monitors in monitors/monitors.json (or manifest
// experimental.monitors): [{ name, command, description, when }]. `when` is
// "always" (default, start with the interactive session) or
// "on-skill-invoke:<skill>" (start the first time that skill runs).
import './tools.mjs'; // load order: tools.mjs before power-tools.mjs (they import each other)
import { startBackgroundProcess, killBackgroundEntry } from './power-tools.mjs';
import { createBoundedRegexMatcher } from './safe-regex.mjs';

export const MONITOR_DEFAULT_TIMEOUT_MS = 300000;
export const MONITOR_MAX_TIMEOUT_MS = 3600000;
export const MONITOR_HEADLESS_MAX_MS = 600000;
const FLUSH_MS = 250;
const MAX_LINES_PER_EVENT = 40;
const MAX_EVENT_CHARS = 4000;
const MAX_LINE_CHARS = 1000;

export { MONITOR_TOOL_DEFINITION } from './monitor-definition.mjs';

// ---------------------------------------------------------------- events

export function pushBackgroundEvent(session, text, meta = {}) {
  if (!session) return;
  (session.inbox || (session.inbox = [])).push({ text, kind: meta.kind || 'monitor', id: meta.id || null });
  if (typeof session.onBackgroundEvent === 'function') {
    try { session.onBackgroundEvent({ text, ...meta }); } catch {}
  }
}

function escapeAttr(value) { return String(value || '').replace(/[&"<>\n\r]/g, (c) => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' }[c] || ' ')); }
function clip(line) { const clean = String(line).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ''); return clean.length > MAX_LINE_CHARS ? clean.slice(0, MAX_LINE_CHARS) + '…' : clean; }

// Batches lines per monitor so a burst becomes one event, not hundreds.
function lineBatcher(session, monitor) {
  let buffer = [];
  let dropped = 0;
  let timer = null;
  let pending = Promise.resolve();
  let queued = 0;
  let disabled = false;
  const flushEvent = () => {
    timer = null;
    if (!buffer.length && !dropped) return;
    let body = buffer.join('\n');
    if (body.length > MAX_EVENT_CHARS) body = body.slice(0, MAX_EVENT_CHARS) + '…';
    if (dropped) body += '\n[' + dropped + ' more line(s) skipped; print fewer lines or use a pattern]';
    monitor.events += 1;
    pushBackgroundEvent(session, '<monitor-event id="' + monitor.id + '" description="' + escapeAttr(monitor.description) + '">\n' + body + '\n</monitor-event>', { kind: 'monitor', id: monitor.id, description: monitor.description, lines: buffer.length });
    buffer = []; dropped = 0;
  };
  const scheduleFlush = () => {
    if (!timer) { timer = setTimeout(flushEvent, FLUSH_MS); timer.unref?.(); }
  };
  const append = (line) => {
    if (buffer.length >= MAX_LINES_PER_EVENT) dropped += 1;
    else buffer.push(clip(line));
    scheduleFlush();
  };
  return {
    add(line) {
      const value = String(line);
      if (!value.trim() || disabled) return;
      if (!monitor.pattern) { append(value); return; }
      if (queued >= 128) { dropped += 1; scheduleFlush(); return; }
      queued++;
      pending = pending.then(async () => {
        if (!disabled && monitor.pattern && await monitor.pattern.test(value.slice(0, 8000))) append(value);
      }).catch((error) => {
        disabled = true;
        const matcher = monitor.pattern;
        monitor.pattern = null;
        if (matcher) void matcher.close().catch(() => {});
        pushBackgroundEvent(session,
          '<monitor-event id="' + monitor.id + '" description="' + escapeAttr(monitor.description) + '">\nPattern matching stopped: ' + escapeAttr(error.message || error) + '\n</monitor-event>',
          { kind: 'monitor', id: monitor.id, description: monitor.description });
      }).finally(() => { queued = Math.max(0, queued - 1); });
    },
    async flush() {
      await pending;
      if (timer) clearTimeout(timer);
      flushEvent();
      const matcher = monitor.pattern;
      monitor.pattern = null;
      if (matcher) await matcher.close();
    }
  };
}

async function compilePattern(pattern) {
  if (!pattern) return null;
  let matcher;
  try {
    matcher = createBoundedRegexMatcher(String(pattern).slice(0, 500), '', { timeoutMs: 250 });
    await matcher.ready;
    return matcher;
  } catch (error) {
    if (matcher) await matcher.close().catch(() => {});
    throw new Error('Invalid pattern: ' + error.message);
  }
}

export function monitorTimeout(args = {}, { headless = false } = {}) {
  if (args.persistent === true && !headless) return 0;
  const requested = args.persistent === true ? Infinity : Number(args.timeout_ms) > 0 ? Number(args.timeout_ms) : MONITOR_DEFAULT_TIMEOUT_MS;
  return Math.max(1000, Math.min(headless ? MONITOR_HEADLESS_MAX_MS : MONITOR_MAX_TIMEOUT_MS, requested));
}

function endNotice(monitor, entry, reason) {
  const how = reason === 'timeout' ? 'stopped at its ' + Math.round(monitor.timeoutMs / 1000) + 's deadline'
    : reason === 'stopped' ? 'was stopped'
      : entry && entry.status === 'failed' ? 'failed to run'
        : 'exited' + (entry && entry.exitCode !== null && entry.exitCode !== undefined ? ' with code ' + entry.exitCode : '') + (entry && entry.signal ? ' (' + entry.signal + ')' : '');
  const tail = entry && entry.exitCode && entry.output ? '\nLast output:\n' + entry.output.slice(-800).trim() : '';
  return '<monitor-event id="' + monitor.id + '" description="' + escapeAttr(monitor.description) + '" ended="true">\nMonitor ' + how + ' after ' + monitor.events + ' event(s).' + tail + '\n</monitor-event>';
}

export function activeMonitors(session) {
  if (!session || !session.background) return [];
  return [...session.background.values()].filter((entry) => entry.monitor && entry.status === 'running');
}

// Monitors the model started (not plugin monitors), for the headless runner.
export function activeAgentMonitors(session) {
  return activeMonitors(session).filter((entry) => !entry.monitor.plugin);
}

/**
 * Start a command monitor. `run` is runWorkspaceCommand-compatible and handles
 * analysis, permission prompts and sandboxing. Returns the tool result.
 */
export async function startCommandMonitor(session, args, { run, root, runOptions = {}, headless = false }) {
  const description = String(args.description || '').trim().slice(0, 200);
  if (!description) throw new Error('monitor needs a description.');
  if (args.ws && args.command) throw new Error('Give either command or ws, not both.');
  if (!args.command) throw new Error('monitor needs a command (or ws).');
  const pattern = await compilePattern(args.pattern);
  const timeoutMs = monitorTimeout(args, { headless });
  const monitor = { id: null, description, pattern, timeoutMs, events: 0, plugin: null };
  const batcher = lineBatcher(session, monitor);
  let timer = null;
  let endReason = null;
  let result;
  try {
    result = await run(root, args.command, Array.isArray(args.args) ? args.args : [], {
      ...runOptions,
      background: true,
      monitor,
      onLine: (line) => batcher.add(line),
      onExit: (entry, { stoppedByUser }) => {
        if (timer) clearTimeout(timer);
        void batcher.flush().catch(() => {}).then(() => {
          pushBackgroundEvent(session, endNotice(monitor, entry, endReason || (stoppedByUser ? 'stopped' : 'exited')), { kind: 'monitor-end', id: monitor.id, description });
        });
      }
    });
  } catch (error) {
    await batcher.flush().catch(() => {});
    throw error;
  }
  if (!result || !result.id) {
    await batcher.flush();
    return result;
  }
  monitor.id = result.id;
  const entry = session.background && session.background.get(result.id);
  if (entry) entry.monitor = monitor;
  if (timeoutMs && entry) {
    timer = setTimeout(() => { endReason = 'timeout'; killBackgroundEntry(entry); }, timeoutMs);
    timer.unref?.();
  }
  return {
    id: result.id, monitoring: true, description, pid: result.pid,
    deadline: timeoutMs ? Math.round(timeoutMs / 1000) + 's' : 'none (persistent)',
    message: 'Monitoring. Each new output line' + (pattern ? ' matching the pattern' : '') + ' arrives as a <monitor-event id="' + result.id + '"> notice. Stop it with kill_command id ' + result.id + '.'
  };
}

// ---------------------------------------------------------------- WebSocket watch

export function validateWsUrl(raw) {
  const text = String(raw || '');
  if (!text || /\s/.test(text) || /[^\x20-\x7e]/.test(text)) throw new Error('ws.url must be an ASCII ws:// or wss:// URL with no whitespace.');
  let url;
  try { url = new URL(text); } catch { throw new Error('ws.url is not a valid URL.'); }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') throw new Error('ws.url must start with ws:// or wss://.');
  if (url.username || url.password) throw new Error('ws.url must not embed credentials.');
  return url.toString();
}

export function validateWsProtocols(list) {
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error('ws.protocols must be an array.');
  const seen = new Set();
  for (const name of list) {
    if (typeof name !== 'string' || !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(name)) throw new Error('Invalid WebSocket subprotocol: ' + name);
    if (seen.has(name)) throw new Error('Duplicate WebSocket subprotocol: ' + name);
    seen.add(name);
  }
  return list;
}

export async function startWsMonitor(session, args, { approval, autoApprove = false, ruleAllowed = false, headless = false, WebSocketImpl = globalThis.WebSocket }) {
  const description = String(args.description || '').trim().slice(0, 200);
  if (!description) throw new Error('monitor needs a description.');
  const url = validateWsUrl(args.ws && args.ws.url);
  const protocols = validateWsProtocols(args.ws && args.ws.protocols);
  if (typeof WebSocketImpl !== 'function') throw new Error('WebSocket is not available in this Node.js version.');
  if (!(autoApprove || ruleAllowed)) {
    const ok = approval && await approval('Open a WebSocket and treat its messages as events?\n  ' + url);
    if (!ok) return { approved: false, message: 'WebSocket monitor was not approved.' };
  }
  const registry = session.background || (session.background = new Map());
  const id = 'ws_' + Math.random().toString(16).slice(2, 10);
  const pattern = await compilePattern(args.pattern);
  const timeoutMs = monitorTimeout(args, { headless });
  const monitor = { id, description, pattern, timeoutMs, events: 0, plugin: null };
  const batcher = lineBatcher(session, monitor);
  let socket;
  try {
    socket = protocols.length ? new WebSocketImpl(url, protocols) : new WebSocketImpl(url);
  } catch (error) {
    await batcher.flush().catch(() => {});
    throw error;
  }
  let endReason = null;
  let timer = null;
  const entry = {
    id, command: 'ws ' + url, pid: null, status: 'running', exitCode: null, output: '', readOffset: 0, dropped: 0, startedAt: new Date().toISOString(), monitor,
    child: { kill() { endReason = endReason || 'stopped'; try { socket.close(); } catch {} } }
  };
  registry.set(id, entry);
  const finish = async () => {
    if (entry.status === 'running' || entry.status === 'killed') entry.status = entry.status === 'killed' ? 'killed' : 'exited';
    if (timer) clearTimeout(timer);
    await batcher.flush();
    pushBackgroundEvent(session, endNotice(monitor, entry, endReason || (entry.status === 'killed' ? 'stopped' : 'exited')), { kind: 'monitor-end', id, description });
  };
  let closed = false;
  const onMessage = async (event) => {
    let data = event && 'data' in event ? event.data : event;
    if (data && typeof data.text === 'function') data = await data.text();
    else if (data instanceof ArrayBuffer) data = Buffer.from(data).toString('utf8');
    const text = String(data);
    entry.output = (entry.output + text + '\n').slice(-200000);
    for (const line of text.split(/\r?\n/)) batcher.add(line);
  };
  socket.addEventListener('message', (event) => { onMessage(event).catch(() => {}); });
  socket.addEventListener('error', () => { entry.output += '[oasis] WebSocket error\n'; });
  socket.addEventListener('close', () => { if (closed) return; closed = true; void finish().catch(() => {}); });
  if (timeoutMs) { timer = setTimeout(() => { endReason = 'timeout'; try { socket.close(); } catch {} }, timeoutMs); timer.unref?.(); }
  return { id, monitoring: true, description, url, deadline: timeoutMs ? Math.round(timeoutMs / 1000) + 's' : 'none (persistent)', message: 'Connected. Each message arrives as a <monitor-event id="' + id + '"> notice. Stop it with kill_command id ' + id + '.' };
}

// ---------------------------------------------------------------- background command completion

export function backgroundExitNotifier(session) {
  return (entry, { stoppedByUser } = {}) => {
    if (stoppedByUser || entry.monitor) return;
    const code = entry.status === 'failed' ? 'failed to start' : entry.status === 'timed_out' ? 'was stopped after reaching max_seconds=' + entry.maxSeconds : 'exited' + (entry.exitCode !== null && entry.exitCode !== undefined ? ' with code ' + entry.exitCode : '') + (entry.signal ? ' (' + entry.signal + ')' : '');
    const unread = entry.output.slice(Math.min(entry.readOffset, entry.output.length)).trim();
    pushBackgroundEvent(session, '<background-command id="' + entry.id + '" command="' + escapeAttr(entry.command).slice(0, 200) + '">\nBackground command ' + code + '.' + (unread ? '\nUnread output (tail):\n' + unread.slice(-1500) : '') + '\nUse command_output with id ' + entry.id + ' for the full output.\n</background-command>', { kind: 'background-exit', id: entry.id });
  };
}

export function backgroundStuckNotifier(session) {
  return (entry, quietSeconds) => {
    const minutes = Math.max(1, Math.round(quietSeconds / 60));
    pushBackgroundEvent(session, '<background-command id="' + entry.id + '" command="' + escapeAttr(entry.command).slice(0, 200) + '">\nBackground command has produced no output for about ' + minutes + ' minute(s). ' +
      'It may be stuck, deadlocked, or waiting for input it cannot receive (background commands have no stdin). Check command_output with id ' + entry.id +
      ', and stop it with kill_command if it is not making progress. Long-running servers that are simply idle can be left alone.\n</background-command>', { kind: 'background-stuck', id: entry.id });
  };
}

// ---------------------------------------------------------------- plugin monitors

const MONITOR_KEYS = new Set(['name', 'command', 'description', 'when']);

export function validatePluginMonitors(list, pluginName = 'plugin') {
  if (!Array.isArray(list)) throw new Error(pluginName + ': monitors must be an array');
  const names = new Set();
  return list.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(pluginName + ': monitor #' + (index + 1) + ' must be an object');
    for (const key of Object.keys(item)) if (!MONITOR_KEYS.has(key)) throw new Error(pluginName + ': monitor "' + (item.name || index + 1) + '" has unknown key "' + key + '"');
    for (const key of ['name', 'command', 'description']) if (typeof item[key] !== 'string' || !item[key].trim()) throw new Error(pluginName + ': monitor #' + (index + 1) + ' needs a ' + key);
    if (names.has(item.name)) throw new Error(pluginName + ': duplicate monitor name "' + item.name + '"');
    names.add(item.name);
    const when = item.when === undefined ? 'always' : String(item.when);
    if (when !== 'always' && !/^on-skill-invoke:\S+$/.test(when)) throw new Error(pluginName + ': monitor "' + item.name + '" has an invalid when: ' + when);
    if (/\$\{user_config\./.test(item.command)) throw new Error(pluginName + ': monitor "' + item.name + '" cannot reference ${user_config.*}');
    return { name: item.name.trim(), command: item.command, description: item.description.trim(), when };
  });
}

function shellLaunch(command) {
  return process.platform === 'win32' ? { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] } : { command: '/bin/sh', args: ['-c', command] };
}

/** Start one plugin monitor (already expanded). Returns the background id. */
export function startPluginMonitor(session, spec, { root, env = process.env } = {}) {
  session.pluginMonitorsStarted ||= new Set();
  const key = spec.plugin + ':' + spec.name;
  if (session.pluginMonitorsStarted.has(key)) return null;
  session.pluginMonitorsStarted.add(key);
  const registry = session.background || (session.background = new Map());
  const monitor = { id: null, description: spec.plugin + ':' + spec.name + ' — ' + spec.description, pattern: null, timeoutMs: 0, events: 0, plugin: spec.plugin };
  const batcher = lineBatcher(session, monitor);
  const launch = shellLaunch(spec.command);
  const result = startBackgroundProcess(registry, launch, {
    cwd: root || session.root, env: { ...env, ...(spec.env || {}) }, display: spec.plugin + ':' + spec.name, monitor,
    onLine: (line) => batcher.add(line),
    onExit: (entry, { stoppedByUser }) => {
      void batcher.flush().catch(() => {}).then(() => {
        if (!stoppedByUser && !session.closing) pushBackgroundEvent(session, endNotice(monitor, entry, 'exited'), { kind: 'monitor-end', id: monitor.id, description: monitor.description });
      });
    }
  });
  monitor.id = result.id;
  return result.id;
}

/** Start plugin monitors for a trigger: 'always' at session start, or a skill name. */
export function startPluginMonitorsFor(session, trigger, options = {}) {
  const specs = session.pluginMonitors || (session.settings && session.settings.pluginMonitors) || [];
  const started = [];
  for (const spec of specs) {
    let matches = false;
    if (trigger === 'always') matches = spec.when === 'always';
    else if (spec.when.startsWith('on-skill-invoke:')) {
      const wanted = spec.when.slice('on-skill-invoke:'.length);
      const invoked = String(trigger);
      matches = wanted === invoked || spec.plugin.split('@')[0] + ':' + wanted === invoked || wanted === invoked.split(':').pop() && invoked.startsWith(spec.plugin.split('@')[0] + ':');
    }
    if (!matches) continue;
    try { const id = startPluginMonitor(session, spec, options); if (id) started.push(id); } catch (error) { (session.hookMessages ||= []).push('Plugin monitor ' + spec.plugin + ':' + spec.name + ' failed to start: ' + error.message); }
  }
  return started;
}

