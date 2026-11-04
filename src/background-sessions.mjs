// Background sessions (`--bg`, /background and /bg): a detached headless
// Oasis process works on a task while the terminal is free. Each run has a registry entry
// in <oasis config>/background/<id>.json and a stream-json log next to it.
//
//   oasis --bg "task"          start a new background session
//   /background [prompt]       hand the current conversation to a background session
//   oasis bg [list]            list runs        oasis bg logs ID [--follow]
//   oasis bg attach ID         resume it here   oasis bg stop ID   oasis bg rm ID
//   oasis respawn ID|--all     restart with the conversation intact
//   oasis --bg --exec 'cmd'    run a shell command as a background job (logs/stop/rm work the same)
// attach/logs/stop/rm/respawn are also top-level commands and accept an id prefix or part of a name.
import { spawn } from 'node:child_process';
import { signalProcessTree } from './process-tree.mjs';
import { randomUUID } from 'node:crypto';
import { closeSync, openSync, readFileSync } from 'node:fs';
import { appendFile, open as openFile } from 'node:fs/promises';
import os from 'node:os';
import { mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigDirectory } from './config.mjs';

const CLI = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const ID = /^bg-[a-z0-9]{6,12}$/;

export function backgroundDirectory(env = process.env) {
  return path.join(getConfigDirectory(env), 'background');
}

function entryPath(id, env) {
  if (!ID.test(String(id))) throw new Error('Unknown background session id ' + id + '.');
  return path.join(backgroundDirectory(env), id + '.json');
}

async function writeEntry(entry, env) {
  const file = entryPath(entry.id, env);
  // A unique same-directory temp file prevents overlapping writers in one
  // process from sharing a pathname. Rename publishes a complete JSON snapshot
  // so readers never observe an empty/truncated registry entry.
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export async function readEntry(id, env = process.env) {
  const entry = JSON.parse(await readFile(entryPath(id, env), 'utf8'));
  return refreshStatus(entry);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

// Identifies the current boot so a PID recorded before a reboot or crash is not
// mistaken for a live run when the OS reuses it. Linux exposes a boot id; other
// platforms use the boot time rounded to a minute.
let cachedBootId = null;
export function currentBootId() {
  if (cachedBootId) return cachedBootId;
  try { cachedBootId = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch {}
  if (!cachedBootId) cachedBootId = 'boot-' + Math.round((Date.now() - os.uptime() * 1000) / 60000);
  return cachedBootId;
}

// A run still marked "running" whose process is gone (crash, kill -9, reboot,
// sleep-killed laptop) never reached finishBackgroundSession. It is reported as
// "interrupted" so it can be resumed with `oasis respawn --interrupted`.
function refreshStatus(entry) {
  if (entry.status !== 'running') return entry;
  const rebooted = entry.bootId && entry.bootId !== currentBootId();
  if (rebooted || !alive(entry.pid)) return { ...entry, status: 'interrupted', ...(rebooted ? { interruptedBy: 'reboot' } : {}) };
  return entry;
}

// Steering a running background agent: `oasis bg send ID "message"` appends to
// <id>.inbox.jsonl; the agent picks it up at its next step as a user message.
export function inboxPath(id, env = process.env) {
  return entryPath(id, env).replace(/\.json$/, '.inbox.jsonl');
}

export async function sendToBackgroundSession(id, text, env = process.env) {
  const message = String(text == null ? '' : text).trim();
  if (!message) throw new Error('Usage: oasis bg send ID "message"');
  const entry = await readEntry(id, env);
  if (entry.kind === 'exec') throw new Error(id + ' is a shell job, not an agent; it cannot take messages.');
  if (entry.status !== 'running') throw new Error(id + ' is ' + entry.status + '. Use oasis respawn ' + id + ' to restart it, then send the message.');
  await appendFile(inboxPath(id, env), JSON.stringify({ text: message.slice(0, 20000), at: new Date().toISOString() }) + '\n', { mode: 0o600 });
  return entry;
}

// Atomically takes every queued message (rename, then read) so a message sent
// while draining lands in a fresh inbox and is never lost or read twice.
export async function drainInbox(id, env = process.env) {
  const file = inboxPath(id, env);
  const taking = file + '.' + process.pid + '.' + randomUUID() + '.taking';
  try { await rename(file, taking); } catch { return []; }
  let text = '';
  try { text = await readFile(taking, 'utf8'); } finally { await unlink(taking).catch(() => {}); }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const item = JSON.parse(line); if (item && typeof item.text === 'string' && item.text.trim()) out.push(item.text.trim()); } catch {}
  }
  return out;
}

export function watchInbox(id, onMessage, env = process.env, intervalMs = 500) {
  let busy = false;
  const timer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try { for (const text of await drainInbox(id, env)) onMessage(text); } catch {} finally { busy = false; }
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

// Approval relay: a background agent that hits an action needing approval writes
// <id>.approval.json and waits; `oasis bg approve ID` / `oasis bg deny ID` answer
// it through <id>.decision.json (matched by requestId, so a stale answer never
// approves a later request). Unanswered requests are denied after the timeout.
export function approvalPath(id, env = process.env) {
  return entryPath(id, env).replace(/\.json$/, '.approval.json');
}

function decisionPath(id, env) {
  return entryPath(id, env).replace(/\.json$/, '.decision.json');
}

async function writeAtomic(file, value) {
  const temp = file + '.' + process.pid + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await rename(temp, file);
  } finally { await unlink(temp).catch(() => {}); }
}

export async function pendingApproval(id, env = process.env) {
  try {
    const value = JSON.parse(await readFile(approvalPath(id, env), 'utf8'));
    return value && value.requestId ? value : null;
  } catch { return null; }
}

let approvalChain = Promise.resolve();

// Resolves to 'allow', 'always', 'deny' or 'timeout'. Requests from one process
// are asked one at a time, so parallel tool calls queue instead of overwriting.
export function requestBackgroundApproval(id, request = {}, env = process.env, options = {}) {
  const run = approvalChain.then(() => askOnce(id, request, env, options));
  approvalChain = run.catch(() => {});
  return run;
}

async function askOnce(id, request, env, options) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30 * 60 * 1000;
  const pollMs = Number(options.pollMs) > 0 ? Number(options.pollMs) : 500;
  const requestId = randomUUID();
  const pending = { requestId, tool: request.tool || null, message: String(request.message || '').replace(/\s+/g, ' ').trim().slice(0, 2000), canAlways: Boolean(request.canAlways), at: new Date().toISOString(), expiresAt: new Date(Date.now() + timeoutMs).toISOString() };
  await unlink(decisionPath(id, env)).catch(() => {});
  await writeAtomic(approvalPath(id, env), pending);
  if (options.onRequest) { try { options.onRequest(pending); } catch {} }
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      if (options.signal && options.signal.aborted) return 'deny';
      let decision = null;
      try { decision = JSON.parse(await readFile(decisionPath(id, env), 'utf8')); } catch {}
      if (decision && decision.requestId === requestId) {
        await unlink(decisionPath(id, env)).catch(() => {});
        if (decision.behavior === 'allow') return decision.always && pending.canAlways ? 'always' : 'allow';
        return 'deny';
      }
      await new Promise((resolve) => { setTimeout(resolve, Math.min(pollMs, Math.max(1, deadline - Date.now()))); });
    }
    return 'timeout';
  } finally {
    const current = await pendingApproval(id, env);
    if (current && current.requestId === requestId) await unlink(approvalPath(id, env)).catch(() => {});
  }
}

export async function answerBackgroundApproval(id, behavior, env = process.env, options = {}) {
  if (behavior !== 'allow' && behavior !== 'deny') throw new Error('behavior must be allow or deny');
  const entry = await readEntry(id, env);
  const pending = await pendingApproval(id, env);
  if (!pending || entry.status !== 'running') throw new Error(id + ' has no pending approval' + (entry.status !== 'running' ? ' (it is ' + entry.status + ').' : '.'));
  await writeAtomic(decisionPath(id, env), { requestId: pending.requestId, behavior, ...(options.always ? { always: true } : {}), ...(options.reason ? { reason: String(options.reason).slice(0, 500) } : {}), at: new Date().toISOString() });
  return pending;
}

// One line on what a background agent is doing now, from the tail of its log.
export function summarizeActivity(logText) {
  const lines = String(logText || '').split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let event;
    try { event = JSON.parse(raw); } catch { continue; }
    if (event.type === 'result' && event.subtype !== 'turn') return (event.is_error ? 'failed' : 'done') + (event.result ? ': ' + String(event.result).replace(/\s+/g, ' ').slice(0, 70) : '');
    if (event.type === 'tool_use') {
      const input = event.input || {};
      const detail = input.command || input.path || input.file_path || input.pattern || input.query || input.url || '';
      return 'running ' + event.name + (detail ? ' ' + String(detail).replace(/\s+/g, ' ').slice(0, 60) : '');
    }
    if (event.type === 'assistant' && event.text) return String(event.text).replace(/\s+/g, ' ').trim().slice(0, 80);
    if (event.type === 'system' && event.subtype === 'steer_received') return 'received your message';
    if (event.type === 'system' && event.subtype === 'permission_request') return 'needs approval: ' + String(event.message || event.tool || '').replace(/\s+/g, ' ').slice(0, 70);
    if (event.type === 'system' && event.subtype === 'permission') return (event.allowed ? 'approved ' : 'denied ') + (event.tool || 'action');
  }
  return '';
}

export async function readActivity(entry, maxBytes = 65536) {
  let handle;
  try {
    handle = await openFile(entry.logFile, 'r');
    const { size } = await handle.stat();
    const start = Math.max(0, size - maxBytes);
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    return summarizeActivity(buffer.toString('utf8'));
  } catch { return ''; } finally { await handle?.close().catch(() => {}); }
}

export async function startBackgroundSession(options = {}) {
  const env = options.env || process.env;
  const root = path.resolve(options.root || process.cwd());
  const prompt = String(options.prompt || '').trim();
  if (!prompt) throw new Error('A background session needs a task: oasis --bg "describe the task".');
  const dir = backgroundDirectory(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = options.id && ID.test(options.id) ? options.id : 'bg-' + randomUUID().replace(/-/g, '').slice(0, 8);
  const sessionId = options.resumeId || randomUUID();
  const runId = randomUUID();
  const logFile = path.join(dir, id + '.log');
  const args = [CLI, '-p', prompt, '--output-format', 'stream-json', '--workspace', root];
  if (options.resumeId) args.push('--resume', options.resumeId); else args.push('--session-id', sessionId);
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.model) args.push('--model', options.model);
  if (options.name) args.push('--name', options.name);
  for (const extra of options.extraArgs || []) args.push(extra);
  const entry = { id, runId, sessionId, root, prompt: prompt.slice(0, 500), status: 'running', startedAt: new Date().toISOString(), bootId: currentBootId(), logFile, pid: 0, ...(options.name ? { name: String(options.name) } : {}), ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}), ...(options.model ? { model: options.model } : {}), ...(options.resumeId ? { handoff: true } : {}), ...(options.respawns ? { respawns: options.respawns } : {}) };
  await writeEntry(entry, env);
  const out = openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(options.execPath || process.execPath, args, { cwd: root, env: { ...env, OASIS_BACKGROUND_ID: id, OASIS_BACKGROUND_RUN_ID: runId }, detached: true, stdio: ['ignore', out, out], windowsHide: true });
    entry.pid = child.pid;
    child.unref();
  } finally { closeSync(out); }
  await writeEntry(entry, env);
  return entry;
}

// --exec: a shell command as a detached background job. Output goes to the same log the
// session commands read, and a small wrapper records the exit code when it finishes.
export async function startExecJob(options = {}) {
  const env = options.env || process.env;
  const root = path.resolve(options.root || process.cwd());
  const command = String(options.command || '').trim();
  if (!command) throw new Error('Usage: oasis --bg --exec "shell command"');
  const dir = backgroundDirectory(env);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = options.id && ID.test(options.id) ? options.id : 'bg-' + randomUUID().replace(/-/g, '').slice(0, 8);
  const logFile = path.join(dir, id + '.log');
  const runId = randomUUID();
  const entry = { id, runId, kind: 'exec', sessionId: null, root, prompt: command.slice(0, 500), command, status: 'running', startedAt: new Date().toISOString(), bootId: currentBootId(), logFile, pid: 0, ...(options.name ? { name: String(options.name) } : {}) };
  await writeEntry(entry, env);
  const runner = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const [command, cwd, entryFile, runId] = process.argv.slice(1);",
    "const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));",
    "async function main() {",
    "  // Parent must publish this runner's PID before the command can finish. This",
    "  // prevents a fast command from writing 'completed' and then being overwritten",
    "  // by the parent's stale initial 'running' snapshot.",
    "  let registered = false;",
    "  for (let i = 0; i < 300; i++) { try { { const current = JSON.parse(fs.readFileSync(entryFile, 'utf8')); if (current.pid === process.pid && current.runId === runId) { registered = true; break; } } } catch {} await wait(10); }",
    "  if (!registered) { process.stderr.write('Background registry startup timed out.\\n'); process.exit(125); }",
    "  const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');",
    "  const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];",
    "  const child = spawn(shell, args, { cwd, stdio: 'inherit', env: { ...process.env, TERM: process.env.TERM || 'xterm-256color', FORCE_COLOR: process.env.FORCE_COLOR || '1' } });",
    "  const stop = () => { try { child.kill('SIGTERM'); } catch {} };",
    "  process.on('SIGTERM', stop); process.on('SIGINT', stop);",
    "  child.on('exit', (code, signal) => {",
    "    const exitCode = code === null ? 128 : code;",
    "    process.stdout.write('\\n[exit ' + exitCode + (signal ? ' ' + signal : '') + ']\\n');",
    "    try { const e = JSON.parse(fs.readFileSync(entryFile, 'utf8')); if (e.status === 'running' && e.runId === runId) { e.status = exitCode === 0 ? 'completed' : 'failed'; e.exitCode = exitCode; e.finishedAt = new Date().toISOString(); const temp = entryFile + '.' + process.pid + '.tmp'; fs.writeFileSync(temp, JSON.stringify(e, null, 2) + '\\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, entryFile); } } catch {}",
    "    process.exit(exitCode);",
    "  });",
    "}",
    "main().catch((error) => { process.stderr.write(String(error && error.message || error) + '\\n'); process.exit(125); });"
  ].join('\n');
  const out = openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(options.execPath || process.execPath, ['-e', runner, command, root, entryPath(id, env), runId], { cwd: root, env: { ...env, OASIS_BACKGROUND_ID: id, OASIS_BACKGROUND_RUN_ID: runId }, detached: true, stdio: ['ignore', out, out], windowsHide: true });
    entry.pid = child.pid;
    child.unref();
  } finally { closeSync(out); }
  await writeEntry(entry, env);
  return entry;
}

// Accepts a full id, an id prefix (with or without "bg-"), or part of a session name.
export async function resolveBackgroundId(query, env = process.env) {
  const text = String(query || '').trim();
  if (!text) throw new Error('Give a background session id or name.');
  if (ID.test(text)) return text;
  const entries = await listBackgroundSessions(env);
  const needle = text.toLowerCase();
  const byId = entries.filter((entry) => entry.id.startsWith(text) || entry.id.startsWith('bg-' + text));
  if (byId.length === 1) return byId[0].id;
  const byName = entries.filter((entry) => entry.name && entry.name.toLowerCase().includes(needle));
  const running = byName.filter((entry) => entry.status === 'running');
  const pick = byName.length === 1 ? byName : running.length === 1 ? running : null;
  if (pick) return pick[0].id;
  const matches = byId.length > 1 ? byId : byName;
  if (matches.length > 1) throw new Error(text + ' matches several background sessions: ' + matches.map((entry) => entry.id + (entry.name ? ' (' + entry.name + ')' : '')).join(', ') + '.');
  throw new Error('No background session matches ' + text + '. oasis bg list shows them.');
}

// claude respawn: restart a background session (running or stopped) with its conversation
// intact, keeping the same id. Exec jobs re-run their command.
export async function respawnBackgroundSession(id, env = process.env, options = {}) {
  const entry = await readEntry(id, env);
  if (entry.status === 'running') await stopBackgroundSession(id, env);
  const respawns = (entry.respawns || 0) + 1;
  if (entry.kind === 'exec') return startExecJob({ id: entry.id, root: entry.root, command: entry.command, name: entry.name, env, execPath: options.execPath });
  return startBackgroundSession({ id: entry.id, root: entry.root, env, resumeId: entry.sessionId, prompt: options.prompt || 'You were restarted. Continue the task where you left off; if it is already finished, say so briefly.', permissionMode: entry.permissionMode, model: entry.model, name: entry.name, respawns, execPath: options.execPath });
}

// Called by the background process itself when its headless run ends.
export async function finishBackgroundSession(id, result = {}, env = process.env) {
  let entry;
  try { entry = JSON.parse(await readFile(entryPath(id, env), 'utf8')); } catch { return; }
  // A stopped/respawned job may reuse the same public ID. An older process must
  // never finish the replacement run after it exits late.
  const runId = env.OASIS_BACKGROUND_RUN_ID;
  if (runId && entry.runId !== runId) return;
  if (entry.status !== 'running') return;
  await writeEntry({ ...entry, status: result.exitCode === 0 ? 'completed' : 'failed', exitCode: result.exitCode, finishedAt: new Date().toISOString() }, env);
}

export async function listBackgroundSessions(env = process.env) {
  let names = [];
  try { names = await readdir(backgroundDirectory(env)); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    if (name.endsWith('.approval.json') || name.endsWith('.decision.json')) continue;
    try {
      const entry = refreshStatus(JSON.parse(await readFile(path.join(backgroundDirectory(env), name), 'utf8')));
      const pending = entry.status === 'running' ? await pendingApproval(entry.id, env) : null;
      out.push(pending ? { ...entry, pendingApproval: pending } : entry);
    } catch {}
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export async function stopBackgroundSession(id, env = process.env) {
  const entry = await readEntry(id, env);
  if (entry.status !== 'running') return { ...entry, stopped: false };
  const processHandle = { pid: entry.pid, kill: (signal) => { try { process.kill(entry.pid, signal); return true; } catch { return false; } } };
  signalProcessTree(processHandle, 'SIGTERM');
  const killTimer = setTimeout(() => signalProcessTree(processHandle, 'SIGKILL'), 1500);
  killTimer.unref?.();
  const stopped = { ...entry, status: 'stopped', finishedAt: new Date().toISOString() };
  await writeEntry(stopped, env);
  return { ...stopped, stopped: true };
}

export async function removeBackgroundSession(id, env = process.env) {
  const entry = await readEntry(id, env);
  if (entry.status === 'running') throw new Error(id + ' is still running. Stop it first with oasis bg stop ' + id + '.');
  await unlink(entryPath(id, env)).catch(() => {});
  await unlink(entry.logFile).catch(() => {});
  await unlink(inboxPath(id, env)).catch(() => {});
  await unlink(approvalPath(id, env)).catch(() => {});
  await unlink(decisionPath(id, env)).catch(() => {});
  return entry;
}

// Turns the stream-json log into readable lines.
export function renderLog(text) {
  const lines = [];
  for (const raw of String(text).split('\n')) {
    if (!raw.trim()) continue;
    let event;
    try { event = JSON.parse(raw); } catch { lines.push(raw); continue; }
    if (event.type === 'system' && event.subtype === 'init') lines.push('[start] ' + (event.model || '') + ' in ' + (event.cwd || ''));
    else if (event.type === 'assistant' && event.text) lines.push(event.text);
    else if (event.type === 'tool_use') lines.push('[tool] ' + event.name + ' ' + JSON.stringify(event.input || {}).slice(0, 160));
    else if (event.type === 'tool_result' && event.is_error) lines.push('[tool error] ' + event.name);
    else if (event.type === 'system' && event.subtype === 'steer_received') lines.push('[message] ' + String(event.text || '').slice(0, 200));
    else if (event.type === 'result' && event.subtype === 'turn') continue;
    else if (event.type === 'result') lines.push('[' + (event.is_error ? 'failed' : 'done') + '] ' + (event.num_turns != null ? event.num_turns + ' turns, ' : '') + (event.total_cost_usd ? '$' + Number(event.total_cost_usd).toFixed(4) : '') + (event.is_error && event.result ? ' ' + event.result : ''));
  }
  return lines.join('\n');
}

export function describeEntry(entry, activity = '') {
  const age = Math.max(0, Math.round((Date.now() - Date.parse(entry.startedAt)) / 60000));
  const status = entry.pendingApproval ? 'needs-input' : entry.status;
  if (entry.pendingApproval) activity = 'waiting for approval: ' + String(entry.pendingApproval.message || entry.pendingApproval.tool || '').slice(0, 80) + '  (oasis bg approve ' + entry.id + ' | deny ' + entry.id + ')';
  return entry.id + '  ' + status.padEnd(11) + (entry.kind === 'exec' ? ' [exec]' : '') + (entry.name ? ' ' + entry.name : '') + ' ' + (age < 60 ? age + 'm' : Math.round(age / 60) + 'h') + ' ago  ' + path.basename(entry.root) + '  ' + entry.prompt.replace(/\s+/g, ' ').slice(0, 60) + (activity ? '\n    └ ' + activity : '');
}
