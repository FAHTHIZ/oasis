// Runtime for plugins exported to OpenCode by `oasis plugin export --to opencode`.
//
// The exported folder has opencode/index.js, opencode/runtime.js (this file,
// copied) and opencode/oasis-plugin.json (the plugin's commands, agents, MCP
// servers and Claude Code hooks). OpenCode loads index.js as a plugin; this
// file turns the plugin into OpenCode's terms:
//
//   config               commands, agents and MCP servers are added (yours win)
//   tool.execute.before  PreToolUse hooks; a deny or exit 2 throws (blocks the
//                        call), updatedInput rewrites the arguments in place
//   tool.execute.after   PostToolUse hooks; additionalContext, a block reason or
//                        exit 2 stderr is appended to the result
//   event session.idle   Stop hooks; a block reason is sent as the next prompt
//   event session.created SessionStart hooks
//
// It has no dependencies beyond Node.js / Bun built-ins, so the exported folder
// works without OASIS installed.
import { spawn } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL_NAMES = { bash: 'Bash', read: 'Read', write: 'Write', edit: 'Edit', multiedit: 'MultiEdit', patch: 'Edit', glob: 'Glob', grep: 'Grep', list: 'LS', webfetch: 'WebFetch', websearch: 'WebSearch', todowrite: 'TodoWrite', todoread: 'TodoRead', task: 'Task' };
const TO_CLAUDE = { filePath: 'file_path', oldString: 'old_string', newString: 'new_string', replaceAll: 'replace_all' };
const TO_OPENCODE = Object.fromEntries(Object.entries(TO_CLAUDE).map(([a, b]) => [b, a]));

export const claudeToolName = (tool) => TOOL_NAMES[tool] || String(tool || '');
export const claudeArgs = (args) => Object.fromEntries(Object.entries(args && typeof args === 'object' ? args : {}).map(([key, value]) => [TO_CLAUDE[key] || key, value]));

// Claude Code matcher rules: plain names (A|B) match exactly; anything else is a regular expression.
export function matcherAccepts(matcher, name) {
  if (!matcher || matcher === '*') return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).map((item) => item.trim()).includes(name);
  try { return new RegExp(matcher).test(name); } catch { return matcher === name; }
}

const envName = (key) => String(key).toUpperCase().replace(/[^A-Z0-9_]/g, '_');

function substitute(text, vars) {
  return String(text)
    .replace(/\$\{user_config\.([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, key) => process.env[envName(key)] ?? '')
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => vars[name] ?? m);
}

function runCommand(command, payload, { env, cwd, timeout }) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] } : { cmd: '/bin/sh', args: ['-c', command] };
    let stdout = '', stderr = '', done = false;
    let child;
    try { child = spawn(shell.cmd, shell.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (error) { resolve({ code: 1, stdout: '', stderr: String(error.message) }); return; }
    const timer = setTimeout(() => { if (!done) { child.kill('SIGKILL'); } }, Math.max(1, Number(timeout) || 60) * 1000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: 1, stdout, stderr: stderr || String(error.message) }); } });
    child.on('close', (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code: code ?? 1, stdout, stderr }); } });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

const parse = (text) => { try { const value = JSON.parse(String(text).trim()); return value && typeof value === 'object' ? value : null; } catch { return null; } };

function openCodeServer(spec, vars) {
  const s = JSON.parse(JSON.stringify(spec), (key, value) => typeof value === 'string' ? substitute(value, vars) : value);
  if (s.url) return { type: 'remote', url: s.url, ...(s.headers ? { headers: s.headers } : {}), enabled: true };
  return { type: 'local', command: [s.command, ...(Array.isArray(s.args) ? s.args : [])], ...(s.env ? { environment: s.env } : {}), enabled: true };
}

/** The OpenCode plugin function for an exported plugin's oasis-plugin.json. */
export function createPlugin(dataUrl) {
  let file = fileURLToPath(dataUrl);
  try { file = realpathSync(file); } catch { /* keep the path as given */ }
  const data = JSON.parse(readFileSync(file, 'utf8'));
  const root = path.dirname(path.dirname(file));
  return async ({ directory, client } = {}) => {
    const cwd = directory || process.cwd();
    const dataDir = path.join(os.homedir(), '.local', 'share', 'oasis-plugin-data', data.name || 'plugin');
    const vars = { CLAUDE_PLUGIN_ROOT: root, OASIS_PLUGIN_ROOT: root, PLUGIN_ROOT: root, CLAUDE_PLUGIN_DATA: dataDir, OASIS_PLUGIN_DATA: dataDir, PLUGIN_DATA: dataDir, CLAUDE_PROJECT_DIR: cwd, OASIS_PROJECT_DIR: cwd };
    const env = { ...process.env, ...vars };
    const hooks = data.hooks || {};
    const run = async (event, target, payload) => {
      const results = [];
      for (const group of hooks[event] || []) {
        if (target !== null && !matcherAccepts(group.matcher, target)) continue;
        for (const hook of group.hooks || []) {
          if (!hook || (hook.type && hook.type !== 'command') || !hook.command) continue;
          results.push(await runCommand(substitute(hook.command, vars), { session_id: payload.session_id, transcript_path: '', cwd, hook_event_name: event, ...payload }, { env, cwd, timeout: hook.timeout }));
        }
      }
      return results;
    };
    const argsByCall = new Map();
    const continued = new Set();
    return {
      config: async (config) => {
        if (!config || typeof config !== 'object') return;
        if (data.commands && Object.keys(data.commands).length) config.command = { ...data.commands, ...(config.command || {}) };
        if (data.agents && Object.keys(data.agents).length) config.agent = { ...data.agents, ...(config.agent || {}) };
        if (data.mcp && Object.keys(data.mcp).length) config.mcp = { ...Object.fromEntries(Object.entries(data.mcp).map(([name, spec]) => [name, openCodeServer(spec, vars)])), ...(config.mcp || {}) };
      },
      'tool.execute.before': async (input, output) => {
        if (!hooks.PreToolUse) return;
        const name = claudeToolName(input.tool);
        argsByCall.set(input.callID, output.args);
        for (const out of await run('PreToolUse', name, { session_id: input.sessionID, tool_name: name, tool_input: claudeArgs(output.args), tool_use_id: input.callID })) {
          if (out.code === 2) throw new Error(out.stderr.trim() || 'Blocked by a ' + data.name + ' hook.');
          const json = out.code === 0 ? parse(out.stdout) : null;
          if (!json) continue;
          const specific = json.hookSpecificOutput || {};
          if (specific.permissionDecision === 'deny' || json.decision === 'block' || json.continue === false) throw new Error(specific.permissionDecisionReason || json.reason || json.stopReason || 'Blocked by a ' + data.name + ' hook.');
          if (specific.updatedInput && typeof specific.updatedInput === 'object') for (const [key, value] of Object.entries(specific.updatedInput)) output.args[TO_OPENCODE[key] || key] = value;
        }
      },
      'tool.execute.after': async (input, output) => {
        const args = input.args || argsByCall.get(input.callID) || {};
        argsByCall.delete(input.callID);
        if (!hooks.PostToolUse) return;
        const name = claudeToolName(input.tool);
        const notes = [];
        for (const out of await run('PostToolUse', name, { session_id: input.sessionID, tool_name: name, tool_input: claudeArgs(args), tool_response: { output: output.output }, tool_use_id: input.callID })) {
          if (out.code === 2 && out.stderr.trim()) { notes.push(out.stderr.trim()); continue; }
          const json = out.code === 0 ? parse(out.stdout) : null;
          if (!json) continue;
          const specific = json.hookSpecificOutput || {};
          if (specific.updatedToolOutput && typeof specific.updatedToolOutput.output === 'string') output.output = specific.updatedToolOutput.output;
          if (json.decision === 'block' && json.reason) notes.push(json.reason);
          if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) notes.push(specific.additionalContext.trim());
        }
        if (notes.length) output.output = String(output.output ?? '') + '\n\n' + notes.join('\n');
      },
      event: async ({ event }) => {
        if (!event) return;
        if (event.type === 'session.created' && hooks.SessionStart) {
          const info = (event.properties && event.properties.info) || {};
          await run('SessionStart', 'startup', { session_id: info.id || '', source: 'startup' });
        }
        if (event.type === 'session.idle' && hooks.Stop) {
          const sessionID = (event.properties && event.properties.sessionID) || '';
          const active = continued.has(sessionID);
          let reason = '';
          for (const out of await run('Stop', null, { session_id: sessionID, stop_hook_active: active })) {
            if (out.code === 2 && out.stderr.trim()) reason = out.stderr.trim();
            const json = out.code === 0 ? parse(out.stdout) : null;
            if (json && json.decision === 'block' && json.reason) reason = json.reason;
          }
          // A Stop hook that blocks keeps the agent working, as in Claude Code.
          if (reason && client && client.session && typeof client.session.prompt === 'function') {
            continued.add(sessionID);
            await client.session.prompt({ path: { id: sessionID }, body: { parts: [{ type: 'text', text: reason }] } });
          } else continued.delete(sessionID);
        }
      }
    };
  };
}
