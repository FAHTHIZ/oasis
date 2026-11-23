#!/usr/bin/env node
// Runs a plugin's Claude Code-format hooks from inside Cursor or Copilot CLI.
//
// `oasis plugin export` copies this file to hooks/oasis-hook-shim.mjs and
// registers it in Cursor's and Copilot's hook files as
//
//   node <plugin>/hooks/oasis-hook-shim.mjs cursor|copilot EVENT
//
// It reads that agent's hook payload on stdin, runs the matching hooks from
// hooks/claude-hooks.json with Claude Code JSON on stdin (and
// CLAUDE_PLUGIN_ROOT / CLAUDE_PROJECT_DIR set), and answers in the agent's
// format: a deny blocks the tool, updatedInput rewrites its arguments, a Stop
// block keeps the agent going, additionalContext reaches the model.
// No dependencies beyond Node.js, so the plugin works without OASIS.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SHIM_EVENTS = {
  cursor: { preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', beforeSubmitPrompt: 'UserPromptSubmit', stop: 'Stop', subagentStop: 'SubagentStop', sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', preCompact: 'PreCompact' },
  copilot: { preToolUse: 'PreToolUse', postToolUse: 'PostToolUse', userPromptSubmitted: 'UserPromptSubmit', agentStop: 'Stop', subagentStop: 'SubagentStop', sessionStart: 'SessionStart', sessionEnd: 'SessionEnd', preCompact: 'PreCompact', notification: 'Notification' }
};

const TOOLS = {
  cursor: { Shell: 'Bash' },
  copilot: { bash: 'Bash', powershell: 'PowerShell', view: 'Read', create: 'Write', edit: 'Edit', grep: 'Grep', glob: 'Glob', web_fetch: 'WebFetch', web_search: 'WebSearch', task: 'Task' }
};
const COPILOT_ARGS = { path: 'file_path', file_text: 'content', old_str: 'old_string', new_str: 'new_string' };
const COPILOT_BACK = Object.fromEntries(Object.entries(COPILOT_ARGS).map(([a, b]) => [b, a]));

export function claudeTool(protocol, name) {
  const tool = String(name || '');
  if (protocol === 'cursor' && tool.startsWith('MCP:')) return 'mcp__' + tool.slice(4);
  return TOOLS[protocol][tool] || tool;
}

export function matcherAccepts(matcher, name) {
  if (!matcher || matcher === '*') return true;
  if (/^[A-Za-z0-9_\- ,|]+$/.test(matcher)) return matcher.split(/[|,]/).map((item) => item.trim()).includes(name);
  try { return new RegExp(matcher).test(name); } catch { return matcher === name; }
}

const parse = (text) => { try { const v = typeof text === 'string' ? JSON.parse(text.trim() || 'null') : text; return v && typeof v === 'object' && !Array.isArray(v) ? v : null; } catch { return null; } };

/** The Claude Code payload for a Cursor or Copilot hook payload. */
export function claudePayload(protocol, foreignEvent, input) {
  const p = input || {};
  const event = SHIM_EVENTS[protocol][foreignEvent];
  const cwd = p.cwd || (Array.isArray(p.workspace_roots) && p.workspace_roots[0]) || process.cwd();
  const base = { session_id: String(p.conversation_id || p.sessionId || p.session_id || ''), transcript_path: String(p.transcript_path || p.transcriptPath || ''), cwd, hook_event_name: event };
  if (protocol === 'cursor') {
    const tool = { tool_name: claudeTool(protocol, p.tool_name), tool_input: parse(p.tool_input) || {}, tool_use_id: p.tool_use_id || '' };
    switch (foreignEvent) {
      case 'preToolUse': return { ...base, ...tool };
      case 'postToolUse': return { ...base, ...tool, tool_response: { output: String(p.tool_output ?? '') } };
      case 'beforeSubmitPrompt': return { ...base, prompt: String(p.prompt || '') };
      case 'stop': case 'subagentStop': return { ...base, stop_hook_active: Number(p.loop_count) > 0 };
      case 'sessionStart': return { ...base, source: 'startup' };
      case 'sessionEnd': return { ...base, reason: p.reason === 'user_close' ? 'exit' : String(p.reason || 'other') };
      case 'preCompact': return { ...base, trigger: p.trigger || 'auto' };
      default: return base;
    }
  }
  const args = Object.fromEntries(Object.entries(parse(p.toolArgs) || {}).map(([k, v]) => [COPILOT_ARGS[k] || k, v]));
  const tool = { tool_name: claudeTool(protocol, p.toolName), tool_input: args };
  switch (foreignEvent) {
    case 'preToolUse': return { ...base, ...tool };
    case 'postToolUse': return { ...base, ...tool, tool_response: { output: String((p.toolResult && p.toolResult.textResultForLlm) ?? '') } };
    case 'userPromptSubmitted': return { ...base, prompt: String(p.prompt || '') };
    case 'agentStop': case 'subagentStop': return { ...base, stop_hook_active: Boolean(p.stop_hook_active) };
    case 'sessionStart': return { ...base, source: p.source === 'resume' ? 'resume' : 'startup' };
    case 'sessionEnd': return { ...base, reason: p.reason === 'user_exit' ? 'exit' : String(p.reason || 'other') };
    case 'preCompact': return { ...base, trigger: p.trigger || 'auto' };
    case 'notification': return { ...base, notification_type: p.notification_type || '', message: String(p.message || '') };
    default: return base;
  }
}

function runCommand(command, payload, { env, cwd, timeout }) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command]] : ['/bin/sh', ['-c', command]];
    let stdout = '', stderr = '', done = false, child;
    const finish = (code) => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr }); } };
    try { child = spawn(shell[0], shell[1], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); } catch (error) { resolve({ code: 1, stdout: '', stderr: String(error.message) }); return; }
    const timer = setTimeout(() => child.kill('SIGKILL'), Math.max(1, Number(timeout) || 60) * 1000);
    child.stdout.on('data', (c) => { stdout += c; });
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('error', (error) => { stderr += String(error.message); finish(1); });
    child.on('close', (code) => finish(code ?? 1));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

/** Run the Claude-format hooks for one event and merge their answers. */
export async function runClaudeHooks(hooks, payload, { root, env = process.env } = {}) {
  const event = payload.hook_event_name;
  const target = payload.tool_name !== undefined ? payload.tool_name : { SessionStart: payload.source, SessionEnd: payload.reason, PreCompact: payload.trigger, Notification: payload.notification_type }[event];
  const vars = { CLAUDE_PLUGIN_ROOT: root, OASIS_PLUGIN_ROOT: root, PLUGIN_ROOT: root, CLAUDE_PROJECT_DIR: payload.cwd, OASIS_PROJECT_DIR: payload.cwd };
  const fullEnv = { ...env, ...vars };
  const merged = { decision: null, reason: '', updatedInput: null, context: [], updatedOutput: null };
  for (const group of (hooks && hooks[event]) || []) {
    if (target !== undefined && target !== null && !matcherAccepts(group.matcher, String(target))) continue;
    for (const hook of group.hooks || []) {
      if (!hook || (hook.type && hook.type !== 'command') || !hook.command) continue;
      const command = String(hook.command).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (m, name) => vars[name] ?? m);
      const out = await runCommand(command, payload, { env: fullEnv, cwd: payload.cwd, timeout: hook.timeout });
      if (out.code === 2) { merged.decision = 'deny'; merged.reason = out.stderr.trim() || 'Blocked by a plugin hook.'; return merged; }
      const json = out.code === 0 ? parse(out.stdout) : null;
      if (!json) { if (out.code === 0 && out.stdout.trim() && ['SessionStart', 'UserPromptSubmit'].includes(event)) merged.context.push(out.stdout.trim()); continue; }
      const s = json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object' ? json.hookSpecificOutput : {};
      if (s.permissionDecision === 'deny' || json.decision === 'block' || json.continue === false) {
        merged.decision = 'deny';
        merged.reason = s.permissionDecisionReason || json.reason || json.stopReason || 'Blocked by a plugin hook.';
        return merged;
      }
      if (s.permissionDecision === 'ask' && merged.decision !== 'ask') { merged.decision = 'ask'; merged.reason = s.permissionDecisionReason || ''; }
      if (s.permissionDecision === 'allow' && !merged.decision) merged.decision = 'allow';
      if (s.updatedInput && typeof s.updatedInput === 'object') merged.updatedInput = { ...(merged.updatedInput || {}), ...s.updatedInput };
      if (s.updatedToolOutput && typeof s.updatedToolOutput.output === 'string') merged.updatedOutput = s.updatedToolOutput.output;
      if (typeof s.additionalContext === 'string' && s.additionalContext.trim()) merged.context.push(s.additionalContext.trim());
    }
  }
  return merged;
}

/** The reply Cursor or Copilot expects on stdout, or null for none. */
export function foreignReply(protocol, foreignEvent, merged) {
  const event = SHIM_EVENTS[protocol][foreignEvent];
  const context = merged.context.join('\n');
  if (protocol === 'cursor') {
    if (event === 'PreToolUse') {
      if (merged.decision === 'deny') return { permission: 'deny', user_message: merged.reason, agent_message: merged.reason };
      return { permission: merged.decision === 'ask' ? 'ask' : 'allow', ...(merged.reason ? { user_message: merged.reason } : {}), ...(merged.updatedInput ? { updated_input: merged.updatedInput } : {}) };
    }
    if (event === 'UserPromptSubmit') return merged.decision === 'deny' ? { continue: false, user_message: merged.reason } : { continue: true };
    if (event === 'Stop' || event === 'SubagentStop') return merged.decision === 'deny' ? { followup_message: merged.reason } : {};
    return context ? { additional_context: context } : {};
  }
  if (event === 'PreToolUse') {
    if (merged.decision === 'deny') return { permissionDecision: 'deny', permissionDecisionReason: merged.reason };
    const out = { ...(merged.decision ? { permissionDecision: merged.decision } : {}), ...(merged.reason ? { permissionDecisionReason: merged.reason } : {}) };
    if (merged.updatedInput) out.modifiedArgs = Object.fromEntries(Object.entries(merged.updatedInput).map(([k, v]) => [COPILOT_BACK[k] || k, v]));
    if (context) out.additionalContext = context;
    return Object.keys(out).length ? out : null;
  }
  if (event === 'Stop' || event === 'SubagentStop') return merged.decision === 'deny' ? { decision: 'block', reason: merged.reason } : null;
  if (event === 'PostToolUse' && merged.updatedOutput !== null) return { modifiedResult: { textResultForLlm: merged.updatedOutput, resultType: 'success' }, ...(context ? { additionalContext: context } : {}) };
  return context ? { additionalContext: context } : null;
}

async function main() {
  const [protocol, foreignEvent] = process.argv.slice(2);
  if (!SHIM_EVENTS[protocol] || !SHIM_EVENTS[protocol][foreignEvent]) { process.stderr.write('Usage: oasis-hook-shim.mjs cursor|copilot EVENT\n'); process.exit(1); }
  const here = path.dirname(fileURLToPath(import.meta.url));
  let hooks = {};
  try { const doc = JSON.parse(readFileSync(path.join(here, 'claude-hooks.json'), 'utf8')); hooks = doc.hooks || doc; } catch { /* no hooks */ }
  let text = '';
  for await (const chunk of process.stdin) text += chunk;
  const payload = claudePayload(protocol, foreignEvent, parse(text) || {});
  const merged = await runClaudeHooks(hooks, payload, { root: path.dirname(here) });
  const reply = foreignReply(protocol, foreignEvent, merged);
  if (reply) process.stdout.write(JSON.stringify(reply) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch((error) => { process.stderr.write(String(error && error.message || error) + '\n'); process.exit(1); });
