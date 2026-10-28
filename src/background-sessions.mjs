// Background sessions (Claude Code's `--bg`, /background and /bg): a detached headless
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
import { randomUUID } from 'node:crypto';
import { closeSync, openSync } from 'node:fs';
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
  const temp = file + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
}

export async function readEntry(id, env = process.env) {
  const entry = JSON.parse(await readFile(entryPath(id, env), 'utf8'));
  return refreshStatus(entry);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function refreshStatus(entry) {
  if (entry.status === 'running' && !alive(entry.pid)) return { ...entry, status: 'exited' };
  return entry;
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
  const logFile = path.join(dir, id + '.log');
  const args = [CLI, '-p', prompt, '--output-format', 'stream-json', '--workspace', root];
  if (options.resumeId) args.push('--resume', options.resumeId); else args.push('--session-id', sessionId);
  if (options.permissionMode) args.push('--permission-mode', options.permissionMode);
  if (options.model) args.push('--model', options.model);
  if (options.name) args.push('--name', options.name);
  for (const extra of options.extraArgs || []) args.push(extra);
  const entry = { id, sessionId, root, prompt: prompt.slice(0, 500), status: 'running', startedAt: new Date().toISOString(), logFile, pid: 0, ...(options.name ? { name: String(options.name) } : {}), ...(options.permissionMode ? { permissionMode: options.permissionMode } : {}), ...(options.model ? { model: options.model } : {}), ...(options.resumeId ? { handoff: true } : {}), ...(options.respawns ? { respawns: options.respawns } : {}) };
  await writeEntry(entry, env);
  const out = openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(options.execPath || process.execPath, args, { cwd: root, env: { ...env, OASIS_BACKGROUND_ID: id }, detached: true, stdio: ['ignore', out, out], windowsHide: true });
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
  const entry = { id, kind: 'exec', sessionId: null, root, prompt: command.slice(0, 500), command, status: 'running', startedAt: new Date().toISOString(), logFile, pid: 0, ...(options.name ? { name: String(options.name) } : {}) };
  await writeEntry(entry, env);
  const runner = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const [command, cwd, entryFile] = process.argv.slice(1);",
    "const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : (process.env.SHELL || '/bin/sh');",
    "const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];",
    "const child = spawn(shell, args, { cwd, stdio: 'inherit', env: { ...process.env, TERM: process.env.TERM || 'xterm-256color', FORCE_COLOR: process.env.FORCE_COLOR || '1' } });",
    "const stop = () => { try { child.kill('SIGTERM'); } catch {} };",
    "process.on('SIGTERM', stop); process.on('SIGINT', stop);",
    "child.on('exit', (code, signal) => {",
    "  const exitCode = code === null ? 128 : code;",
    "  process.stdout.write('\\n[exit ' + exitCode + (signal ? ' ' + signal : '') + ']\\n');",
    "  try { const e = JSON.parse(fs.readFileSync(entryFile, 'utf8')); if (e.status === 'running') { e.status = exitCode === 0 ? 'completed' : 'failed'; e.exitCode = exitCode; e.finishedAt = new Date().toISOString(); fs.writeFileSync(entryFile, JSON.stringify(e, null, 2) + '\\n'); } } catch {}",
    "  process.exit(exitCode);",
    "});"
  ].join('\n');
  const out = openSync(logFile, 'a', 0o600);
  try {
    const child = spawn(options.execPath || process.execPath, ['-e', runner, command, root, entryPath(id, env)], { cwd: root, env: { ...env, OASIS_BACKGROUND_ID: id }, detached: true, stdio: ['ignore', out, out], windowsHide: true });
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
  await writeEntry({ ...entry, status: result.exitCode === 0 ? 'completed' : 'failed', exitCode: result.exitCode, finishedAt: new Date().toISOString() }, env);
}

export async function listBackgroundSessions(env = process.env) {
  let names = [];
  try { names = await readdir(backgroundDirectory(env)); } catch { return []; }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try { out.push(refreshStatus(JSON.parse(await readFile(path.join(backgroundDirectory(env), name), 'utf8')))); } catch {}
  }
  return out.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

export async function stopBackgroundSession(id, env = process.env) {
  const entry = await readEntry(id, env);
  if (entry.status !== 'running') return { ...entry, stopped: false };
  try { process.kill(process.platform === 'win32' ? entry.pid : -entry.pid, 'SIGTERM'); } catch { try { process.kill(entry.pid, 'SIGTERM'); } catch {} }
  const stopped = { ...entry, status: 'stopped', finishedAt: new Date().toISOString() };
  await writeEntry(stopped, env);
  return { ...stopped, stopped: true };
}

export async function removeBackgroundSession(id, env = process.env) {
  const entry = await readEntry(id, env);
  if (entry.status === 'running') throw new Error(id + ' is still running. Stop it first with oasis bg stop ' + id + '.');
  await unlink(entryPath(id, env)).catch(() => {});
  await unlink(entry.logFile).catch(() => {});
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
    else if (event.type === 'result' && event.subtype === 'turn') continue;
    else if (event.type === 'result') lines.push('[' + (event.is_error ? 'failed' : 'done') + '] ' + (event.num_turns != null ? event.num_turns + ' turns, ' : '') + (event.total_cost_usd ? '$' + Number(event.total_cost_usd).toFixed(4) : '') + (event.is_error && event.result ? ' ' + event.result : ''));
  }
  return lines.join('\n');
}

export function describeEntry(entry) {
  const age = Math.max(0, Math.round((Date.now() - Date.parse(entry.startedAt)) / 60000));
  return entry.id + '  ' + entry.status.padEnd(9) + (entry.kind === 'exec' ? ' [exec]' : '') + (entry.name ? ' ' + entry.name : '') + ' ' + (age < 60 ? age + 'm' : Math.round(age / 60) + 'h') + ' ago  ' + path.basename(entry.root) + '  ' + entry.prompt.replace(/\s+/g, ' ').slice(0, 60);
}
