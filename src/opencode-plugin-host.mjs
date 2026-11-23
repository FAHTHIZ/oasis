#!/usr/bin/env node
// Runs one OpenCode plugin file as a Claude Code command hook.
//
//   node opencode-plugin-host.mjs PLUGIN_FILE EVENT   (Claude Code hook JSON on stdin)
//
// OpenCode plugins (.opencode/plugins/*.{js,ts}, ~/.config/opencode/plugins)
// are JavaScript modules whose exported functions return hooks:
//
//   export const Guard = async ({ project, client, $, directory, worktree }) => ({
//     "tool.execute.before": async (input, output) => { ... throw new Error("no") },
//     "tool.execute.after": async (input, output) => { output.output = ... },
//     event: async ({ event }) => { if (event.type === "session.idle") ... }
//   })
//
// foreign-hooks.mjs files this host under the matching OASIS hook events. Here
// the OASIS payload becomes OpenCode's (tool names such as bash and read,
// arguments such as filePath and oldString), the plugin's hook runs, and what it
// did comes back as a Claude Code reply: a throw before a tool denies it, args
// changed in place rewrite the call, output changed after a tool replaces the
// result. Each call loads the plugin fresh, so state kept in module variables
// does not carry from one call to the next. `client` is a stand-in whose calls
// resolve to empty results; `$` runs commands through the system shell.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const OPENCODE_TOOLS = { run_command: 'bash', run_shell: 'bash', powershell: 'bash', read_file: 'read', write_file: 'write', edit_file: 'edit', multi_edit: 'edit', glob_files: 'glob', grep: 'grep', search_files: 'grep', list_files: 'list', fetch_url: 'webfetch', web_search: 'websearch', todo_write: 'todowrite', task: 'task' };
const ARG_NAMES = { path: 'filePath', old_string: 'oldString', new_string: 'newString', replace_all: 'replaceAll' };
const BACK = Object.fromEntries(Object.entries(ARG_NAMES).map(([oasis, opencode]) => [opencode, oasis]));

const quoteWord = (part) => /^[\w@%+=:,./-]+$/.test(part) ? part : "'" + part.replace(/'/g, "'\\''") + "'";

export function openCodeTool(payload) {
  const name = String(payload.tool_name || '');
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) return mcp[1] + '_' + mcp[2];
  return OPENCODE_TOOLS[payload.oasis_tool_name || payload.tool_name_oasis] || name.toLowerCase();
}

export function openCodeArgs(payload) {
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? payload.tool_input : {};
  const out = {};
  for (const [key, value] of Object.entries(input)) out[ARG_NAMES[key] || key] = value;
  if ((payload.oasis_tool_name || payload.tool_name_oasis) === 'run_command') {
    out.command = [input.command, ...(Array.isArray(input.args) ? input.args : [])].filter((part) => part !== undefined && part !== null).map(String).map(quoteWord).join(' ');
    delete out.args;
  }
  return out;
}

// OpenCode arguments back to the OASIS tool's, or { unsupported } when they cannot be.
export function oasisArgs(payload, args) {
  const out = {};
  for (const [key, value] of Object.entries(args)) out[BACK[key] && !(key in (payload.tool_input || {})) ? BACK[key] : key] = value;
  if ((payload.oasis_tool_name || payload.tool_name_oasis) === 'run_command') {
    const line = String(out.command || '').trim();
    if (!/^[\w@%+=:,./ -]+$/.test(line)) return { unsupported: 'the rewritten command uses shell syntax, which run_command cannot take' };
    const [command, ...rest] = line.split(/\s+/);
    delete out.command;
    return { ...out, command, args: rest };
  }
  return out;
}

// A small stand-in for Bun's $ shell: $`git status`.text(), .quiet(), .nothrow().
function makeShell(cwd) {
  const run = (strings, ...values) => {
    const line = strings.reduce((acc, part, index) => acc + part + (index < values.length ? (Array.isArray(values[index]) ? values[index].map((v) => quoteWord(String(v))).join(' ') : quoteWord(String(values[index]))) : ''), '');
    let dir = cwd, nothrow = false;
    let started = null;
    const start = () => started ||= new Promise((resolve, reject) => {
      const child = spawn(line, { cwd: dir, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const out = [], err = [];
      child.stdout.on('data', (chunk) => out.push(chunk));
      child.stderr.on('data', (chunk) => err.push(chunk));
      child.on('error', reject);
      child.on('close', (code) => {
        const result = { exitCode: code ?? 1, stdout: Buffer.concat(out), stderr: Buffer.concat(err), text: () => Buffer.concat(out).toString('utf8'), json: () => JSON.parse(Buffer.concat(out).toString('utf8')) };
        if (result.exitCode !== 0 && !nothrow) { const error = new Error('Command failed (' + result.exitCode + '): ' + line); Object.assign(error, result); reject(error); } else resolve(result);
      });
    });
    const shell = {
      quiet() { return shell; },
      nothrow() { nothrow = true; return shell; },
      cwd(next) { dir = path.resolve(cwd, String(next)); return shell; },
      text: () => start().then((result) => result.text()),
      json: () => start().then((result) => result.json()),
      // Awaitable on purpose, like Bun's $ (await $`cmd`).
      // oxlint-disable-next-line unicorn/no-thenable
      then: (resolve, reject) => start().then(resolve, reject),
      catch: (reject) => start().catch(reject)
    };
    return shell;
  };
  return run;
}

// client.* calls (client.app.log, client.session.prompt, …) resolve to empty results.
function stubClient() {
  const handler = { get: (target, key) => key === 'then' ? undefined : new Proxy(async () => ({ data: null }), handler), apply: async () => ({ data: null }) };
  return new Proxy(() => {}, handler);
}

async function pluginHooks(file, root) {
  const mod = await import(pathToFileURL(file).href);
  const context = { project: { id: root, worktree: root, vcs: 'git' }, directory: root, worktree: root, client: stubClient(), $: makeShell(root), serverUrl: new URL('http://127.0.0.1:0') };
  const factories = [...new Set(Object.values(mod).filter((value) => typeof value === 'function'))];
  const all = [];
  for (const factory of factories) {
    const hooks = await factory(context);
    if (hooks && typeof hooks === 'object') all.push(hooks);
  }
  return all;
}

const EDIT_TOOLS = new Set(['write', 'edit']);

/** Runs the plugin for one OASIS hook event; returns { exitCode, stdout, stderr }. */
export async function runOpenCodePlugin(file, event, payload) {
  const root = payload.cwd || process.cwd();
  const sessionID = String(payload.session_id || 'oasis');
  const callID = String(payload.tool_use_id || '');
  const hooks = await pluginHooks(file, root);
  const emit = async (type, properties) => {
    for (const item of hooks) if (typeof item.event === 'function') await item.event({ event: { type, properties } });
  };
  const tool = openCodeTool(payload);
  if (event === 'PreToolUse') {
    const before = openCodeArgs(payload);
    const output = { args: JSON.parse(JSON.stringify(before)) };
    try {
      for (const item of hooks) if (typeof item['tool.execute.before'] === 'function') await item['tool.execute.before']({ tool, sessionID, callID }, output);
    } catch (error) {
      // OpenCode: a throw stops the call and the model sees the message.
      const reason = String(error && error.message ? error.message : error) || 'Blocked by OpenCode plugin ' + path.basename(file) + '.';
      return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } }), stderr: '' };
    }
    if (JSON.stringify(output.args) === JSON.stringify(before) || !output.args || typeof output.args !== 'object') return { exitCode: 0, stdout: '', stderr: '' };
    const updated = oasisArgs(payload, output.args);
    if (updated.unsupported) return { exitCode: 0, stdout: JSON.stringify({ systemMessage: 'OpenCode plugin ' + path.basename(file) + ': argument rewrite ignored (' + updated.unsupported + ').' }), stderr: '' };
    return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: updated } }), stderr: '' };
  }
  if (event === 'PostToolUse') {
    const response = payload.tool_response;
    const text = typeof response === 'string' ? response : response && typeof response.output === 'string' ? response.output : JSON.stringify(response ?? '');
    const output = { title: '', output: text, metadata: {} };
    for (const item of hooks) if (typeof item['tool.execute.after'] === 'function') await item['tool.execute.after']({ tool, sessionID, callID, args: openCodeArgs(payload) }, output);
    if (EDIT_TOOLS.has(tool)) {
      const file2 = (payload.tool_input || {}).path || (payload.tool_input || {}).file_path;
      if (file2) await emit('file.edited', { file: path.resolve(root, String(file2)) });
    }
    if (typeof output.output === 'string' && output.output !== text) return { exitCode: 0, stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { output: output.output } } }), stderr: '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  if (event === 'Stop') { await emit('session.idle', { sessionID }); return { exitCode: 0, stdout: '', stderr: '' }; }
  if (event === 'SessionStart') { await emit('session.created', { info: { id: sessionID, directory: root, title: '' } }); return { exitCode: 0, stdout: '', stderr: '' }; }
  if (event === 'SessionEnd') { await emit('session.deleted', { info: { id: sessionID, directory: root } }); return { exitCode: 0, stdout: '', stderr: '' }; }
  return { exitCode: 0, stdout: '', stderr: '' };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const [file, event] = process.argv.slice(2);
  let payload = {};
  try { payload = JSON.parse(readFileSync(0, 'utf8') || '{}'); } catch { /* empty */ }
  runOpenCodePlugin(path.resolve(file), event, payload).then((result) => {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  }, (error) => {
    process.stderr.write('OpenCode plugin ' + path.basename(String(file)) + ' failed: ' + String(error && error.message ? error.message : error) + '\n');
    process.exitCode = 1;
  });
}
