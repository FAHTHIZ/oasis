// Hook protocol bridges: run hooks written for other agents under OASIS.
//
// Cursor (hooks.json, version 1) and GitHub Copilot CLI (.github/hooks/*.json)
// hooks are plain commands, like Claude Code's, but they use their own event
// names, their own stdin fields and their own reply fields. A plugin converted
// from either tool keeps its hooks: plugin-convert.mjs files each one under the
// matching Claude Code event with { protocol, foreignEvent } and, when it runs,
// this module turns the OASIS payload into the foreign one and the foreign reply
// back into a Claude Code reply. runHooks then folds the result as usual, so
// deny, ask, rewritten input, extra context and stop follow-ups all keep working.
//
//   toForeignPayload(protocol, foreignEvent, payload, hook) -> object | null
//     null: the hook does not apply to this call (for example a Cursor
//     beforeShellExecution hook and a file read), so it is skipped.
//   fromForeignOutput(protocol, foreignEvent, out, context) -> out
//     The command's { exitCode, stdout, stderr } rewritten so stdout holds
//     Claude Code JSON (hookSpecificOutput, decision, …).
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

export const BRIDGE_PROTOCOLS = ['cursor', 'copilot'];

// Cursor hook events -> the Claude Code event that fires at the same moment,
// and (for tool events) which tools it covers. Events with no OASIS moment
// (Tab completions, model thoughts, opening a workspace) are left out and
// reported by the converter.
export const CURSOR_EVENTS = {
  sessionStart: { event: 'SessionStart' },
  sessionEnd: { event: 'SessionEnd' },
  preToolUse: { event: 'PreToolUse' },
  postToolUse: { event: 'PostToolUse' },
  postToolUseFailure: { event: 'PostToolUseFailure' },
  subagentStart: { event: 'SubagentStart' },
  subagentStop: { event: 'SubagentStop' },
  beforeShellExecution: { event: 'PreToolUse', matcher: 'Bash|PowerShell' },
  afterShellExecution: { event: 'PostToolUse', matcher: 'Bash|PowerShell' },
  beforeMCPExecution: { event: 'PreToolUse', matcher: '^mcp__' },
  afterMCPExecution: { event: 'PostToolUse', matcher: '^mcp__' },
  beforeReadFile: { event: 'PreToolUse', matcher: 'Read' },
  afterFileEdit: { event: 'PostToolUse', matcher: 'Edit|Write|MultiEdit|NotebookEdit' },
  beforeSubmitPrompt: { event: 'UserPromptSubmit' },
  preCompact: { event: 'PreCompact' },
  stop: { event: 'Stop' },
  afterAgentResponse: { event: 'Stop' }
};

// Copilot CLI hook events (camelCase) -> Claude Code events.
export const COPILOT_EVENTS = {
  sessionStart: { event: 'SessionStart' },
  sessionEnd: { event: 'SessionEnd' },
  userPromptSubmitted: { event: 'UserPromptSubmit' },
  preToolUse: { event: 'PreToolUse' },
  postToolUse: { event: 'PostToolUse' },
  postToolUseFailure: { event: 'PostToolUseFailure' },
  errorOccurred: { event: 'StopFailure' },
  agentStop: { event: 'Stop' },
  subagentStart: { event: 'SubagentStart' },
  subagentStop: { event: 'SubagentStop' },
  preCompact: { event: 'PreCompact' },
  permissionRequest: { event: 'PermissionRequest' },
  notification: { event: 'Notification' }
};

export function bridgeEventTable(protocol) {
  return protocol === 'cursor' ? CURSOR_EVENTS : protocol === 'copilot' ? COPILOT_EVENTS : null;
}

// Tool names each agent shows its hooks, by OASIS tool.
const CURSOR_TOOLS = { run_command: 'Shell', run_shell: 'Shell', powershell: 'Shell', read_file: 'Read', write_file: 'Write', edit_file: 'Write', multi_edit: 'Write', notebook_edit: 'Write', delete_file: 'Delete', grep: 'Grep', search_files: 'Grep', glob_files: 'Glob', list_files: 'LS', task: 'Task', fetch_url: 'WebFetch', web_search: 'WebSearch', todo_write: 'TodoWrite' };
const COPILOT_TOOLS = { run_command: 'bash', run_shell: 'bash', powershell: 'powershell', read_file: 'view', list_files: 'view', write_file: 'create', edit_file: 'edit', multi_edit: 'edit', grep: 'grep', search_files: 'grep', glob_files: 'glob', fetch_url: 'web_fetch', web_search: 'web_search', task: 'task' };

const PERMISSION_EVENTS = { cursor: new Set(['preToolUse', 'beforeShellExecution', 'beforeMCPExecution', 'beforeReadFile']), copilot: new Set(['preToolUse']) };

function shellLine(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (name === 'run_command') return [input.command, ...(Array.isArray(input.args) ? input.args : [])].filter((part) => part !== undefined && part !== null).map(String).map((part) => /^[\w@%+=:,./-]+$/.test(part) ? part : "'" + part.replace(/'/g, "'\\''") + "'").join(' ');
  return typeof input.command === 'string' ? input.command : '';
}

function mcpParts(payload) {
  const match = /^mcp__(.+?)__(.+)$/.exec(String(payload.tool_name || ''));
  return match ? { server: match[1], tool: match[2] } : null;
}

function foreignToolName(protocol, payload) {
  const oasis = payload.oasis_tool_name || payload.tool_name_oasis || '';
  const mcp = mcpParts(payload);
  if (protocol === 'cursor') return mcp ? 'MCP:' + mcp.tool : CURSOR_TOOLS[oasis] || payload.tool_name || oasis;
  return mcp ? mcp.server + '-' + mcp.tool : COPILOT_TOOLS[oasis] || oasis || payload.tool_name;
}

// Cursor and Copilot show tools with file_path/command fields; OASIS tools use path.
function foreignToolInput(payload) {
  const input = payload.tool_input && typeof payload.tool_input === 'object' ? { ...payload.tool_input } : {};
  const oasis = payload.oasis_tool_name || payload.tool_name_oasis || '';
  if (typeof input.path === 'string' && input.file_path === undefined) input.file_path = input.path;
  if (oasis === 'run_command') input.command = shellLine(oasis, payload.tool_input);
  return input;
}

// Back to OASIS argument names; only fields the tool already takes.
function oasisToolInput(payload, updated) {
  if (!updated || typeof updated !== 'object' || Array.isArray(updated)) return null;
  const oasis = payload.oasis_tool_name || payload.tool_name_oasis || '';
  const out = { ...updated };
  if (typeof out.file_path === 'string' && (payload.tool_input || {}).path !== undefined) { out.path = out.file_path; delete out.file_path; }
  if (oasis === 'run_command' && typeof out.command === 'string' && out.command !== shellLine(oasis, payload.tool_input)) {
    // A rewritten command line cannot be split back into a program and arguments
    // safely, so only a line with plain words is accepted.
    if (!/^[\w@%+=:,./ -]+$/.test(out.command.trim())) return { unsupported: 'the rewritten command uses shell syntax, which run_command cannot take' };
    const [command, ...args] = out.command.trim().split(/\s+/);
    return { command, args };
  }
  if (oasis === 'run_command') { delete out.command; if (!Object.keys(out).length) return null; }
  return out;
}

function readSmallFile(root, rel) {
  try {
    const file = path.resolve(root || process.cwd(), String(rel || ''));
    if (statSync(file).size > 512 * 1024) return '';
    return readFileSync(file, 'utf8');
  } catch { return ''; }
}

function resultText(response) {
  if (response === undefined || response === null) return '';
  if (typeof response === 'string') return response;
  if (typeof response.output === 'string') return response.output;
  if (typeof response.content === 'string') return response.content;
  try { return JSON.stringify(response); } catch { return String(response); }
}

// Cursor matchers are plain regular expressions; Copilot anchors them (^(?:…)$).
function foreignMatcherAccepts(protocol, matcher, name) {
  if (!matcher || matcher === '*') return true;
  try { return new RegExp(protocol === 'copilot' ? '^(?:' + matcher + ')$' : matcher).test(String(name || '')); } catch { return matcher === name; }
}

/** The stdin payload a Cursor or Copilot hook expects, or null to skip the hook. */
export function toForeignPayload(protocol, foreignEvent, payload, hook = {}) {
  const p = payload || {};
  const cwd = p.cwd || process.cwd();
  const tool = foreignToolName(protocol, p);
  if (hook.foreignMatcher) {
    const target = p.tool_name !== undefined ? tool : protocol === 'copilot' ? { subagentStart: p.agent_type, preCompact: p.trigger, notification: p.notification_type }[foreignEvent] : undefined;
    if (target !== undefined && !foreignMatcherAccepts(protocol, hook.foreignMatcher, target)) return null;
  }
  if (protocol === 'cursor') {
    const base = { conversation_id: p.session_id || 'unsaved', generation_id: p.session_id || 'unsaved', hook_event_name: foreignEvent, cursor_version: 'oasis', workspace_roots: [cwd], user_email: null, transcript_path: p.transcript_path || null, model: p.model || null };
    const input = foreignToolInput(p);
    switch (foreignEvent) {
      case 'beforeShellExecution': return { ...base, command: shellLine(p.oasis_tool_name || p.tool_name_oasis, p.tool_input), cwd, sandbox: false };
      case 'afterShellExecution': return { ...base, command: shellLine(p.oasis_tool_name || p.tool_name_oasis, p.tool_input), output: resultText(p.tool_response), duration: 0, sandbox: false };
      case 'beforeMCPExecution': case 'afterMCPExecution': {
        const mcp = mcpParts(p) || { server: '', tool: p.tool_name };
        const out = { ...base, tool_name: mcp.tool, tool_input: JSON.stringify(p.tool_input || {}), mcp_server_name: mcp.server };
        return foreignEvent === 'afterMCPExecution' ? { ...out, result_json: JSON.stringify(p.tool_response ?? null), duration: 0 } : out;
      }
      case 'beforeReadFile': return { ...base, file_path: input.file_path || '', content: readSmallFile(cwd, input.file_path), attachments: [] };
      case 'afterFileEdit': {
        const edits = Array.isArray(input.edits) ? input.edits.map((e) => ({ old_string: String(e.old_string ?? ''), new_string: String(e.new_string ?? '') }))
          : input.old_string !== undefined ? [{ old_string: String(input.old_string), new_string: String(input.new_string ?? '') }]
            : [{ old_string: '', new_string: String(input.content ?? '') }];
        return { ...base, file_path: input.file_path || '', edits };
      }
      case 'preToolUse': return { ...base, tool_name: tool, tool_input: input, tool_use_id: p.tool_use_id || '', cwd };
      case 'postToolUse': return { ...base, tool_name: tool, tool_input: input, tool_output: resultText(p.tool_response), tool_use_id: p.tool_use_id || '', cwd, duration: 0 };
      case 'postToolUseFailure': return { ...base, tool_name: tool, tool_input: input, error_message: String(p.error || ''), failure_type: 'error', tool_use_id: p.tool_use_id || '', cwd, duration: 0 };
      case 'beforeSubmitPrompt': return { ...base, prompt: String(p.prompt || ''), attachments: [] };
      case 'stop': return { ...base, status: 'completed', loop_count: p.stop_hook_active ? 1 : 0 };
      case 'afterAgentResponse': return { ...base, text: String(p.last_assistant_message || '') };
      case 'subagentStart': return { ...base, subagent_type: p.agent_type || '', task: String(p.prompt || p.description || '') };
      case 'subagentStop': return { ...base, subagent_type: p.agent_type || '', status: 'completed', loop_count: p.stop_hook_active ? 1 : 0 };
      case 'sessionStart': return { ...base, session_id: p.session_id || 'new', is_background_agent: false, composer_mode: 'agent' };
      case 'sessionEnd': return { ...base, session_id: p.session_id || 'unsaved', reason: p.reason === 'exit' ? 'user_close' : String(p.reason || 'completed'), duration_ms: 0 };
      case 'preCompact': return { ...base, trigger: p.trigger || 'auto' };
      default: return { ...base };
    }
  }
  if (protocol === 'copilot') {
    const base = { sessionId: p.session_id || 'unsaved', timestamp: Date.now(), cwd };
    const toolArgs = JSON.stringify(foreignToolInput(p));
    switch (foreignEvent) {
      case 'sessionStart': return { ...base, source: p.source === 'resume' || p.source === 'compact' ? 'resume' : 'startup' };
      case 'sessionEnd': return { ...base, reason: p.reason === 'exit' ? 'user_exit' : String(p.reason || 'complete') };
      case 'userPromptSubmitted': return { ...base, prompt: String(p.prompt || '') };
      case 'preToolUse': return { ...base, toolName: tool, toolArgs };
      case 'postToolUse': return { ...base, toolName: tool, toolArgs, toolResult: { resultType: 'success', textResultForLlm: resultText(p.tool_response) } };
      case 'postToolUseFailure': return { ...base, toolName: tool, toolArgs, toolResult: { resultType: 'failure', textResultForLlm: String(p.error || '') } };
      case 'permissionRequest': return { ...base, toolName: tool, toolArgs };
      case 'errorOccurred': return { ...base, error: { message: String(p.error || ''), name: String(p.error_type || 'Error') }, errorContext: 'model_call', recoverable: false };
      case 'agentStop': return { ...base, transcriptPath: p.transcript_path || '', stopReason: 'end_turn', stop_hook_active: Boolean(p.stop_hook_active) };
      case 'subagentStart': return { ...base, transcriptPath: p.transcript_path || '', agentName: p.agent_type || '', agentDescription: String(p.description || '') };
      case 'subagentStop': return { ...base, transcriptPath: p.transcript_path || '', agentId: p.agent_id || '', agentType: p.agent_type || '', agentName: p.agent_type || '', response: String(p.last_assistant_message || ''), stopReason: 'end_turn' };
      case 'preCompact': return { ...base, transcriptPath: p.transcript_path || '', trigger: p.trigger || 'auto', customInstructions: String(p.custom_instructions || '') };
      case 'notification': return { ...base, hook_event_name: 'Notification', notification_type: p.notification_type || '', message: String(p.message || ''), title: String(p.title || '') };
      default: return base;
    }
  }
  return null;
}

function parse(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) return { empty: true };
  try { const value = JSON.parse(trimmed); return value && typeof value === 'object' && !Array.isArray(value) ? { value } : { invalid: true }; } catch { return { invalid: true }; }
}

const reply = (out, json) => ({ ...out, exitCode: 0, stdout: json ? JSON.stringify(json) : '' });

/** A Cursor or Copilot hook's result, rewritten into a Claude Code hook result. */
export function fromForeignOutput(protocol, foreignEvent, out, context = {}) {
  const permission = PERMISSION_EVENTS[protocol] && PERMISSION_EVENTS[protocol].has(foreignEvent);
  if (!out || out.exitCode !== 0) {
    if (!out) return out;
    const label = (protocol === 'cursor' ? 'Cursor' : 'Copilot') + ' ' + foreignEvent + ' hook';
    if (protocol === 'copilot') {
      // Copilot: exit 2 denies only preToolUse and permissionRequest; on
      // postToolUseFailure its stdout is recovery advice; elsewhere it is a warning.
      // preToolUse also fails closed on any other non-zero exit (not a timeout).
      if (foreignEvent === 'permissionRequest' && out.exitCode === 2) return reply(out, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny', message: String(out.stderr || '').trim() || label + ' denied this.' } } });
      if (foreignEvent === 'preToolUse' && !out.timedOut && out.exitCode !== null) return { ...out, exitCode: 2, stderr: String(out.stderr || '').trim() || label + ' denied this (exit ' + out.exitCode + ').' };
      if (foreignEvent === 'postToolUseFailure' && out.exitCode === 2) return reply(out, String(out.stdout || '').trim() ? { hookSpecificOutput: { hookEventName: 'PostToolUseFailure', additionalContext: String(out.stdout).trim() } } : null);
      if (out.exitCode === 2) return { ...out, exitCode: 1 };
      return out;
    }
    // Cursor: exit 2 denies or blocks, as in Claude Code.
    if (out.exitCode === 2) return { ...out, stderr: String(out.stderr || '').trim() || label + ' blocked this.' };
    return out;
  }
  const parsed = parse(out.stdout);
  if (parsed.invalid) {
    // Cursor: a permission hook whose reply is not JSON blocks (fail closed).
    if (protocol === 'cursor' && permission) return { ...out, exitCode: 2, stdout: '', stderr: 'Cursor ' + foreignEvent + ' hook returned invalid JSON, so the action was blocked.' };
    return { ...out, stdout: '' };
  }
  if (parsed.empty) return { ...out, stdout: '' };
  const json = parsed.value;
  const payload = context.payload || {};
  const event = (bridgeEventTable(protocol)[foreignEvent] || {}).event;
  const messages = [];
  if (protocol === 'cursor') {
    if (permission) {
      const decision = ['allow', 'deny', 'ask'].includes(json.permission) ? json.permission : json.continue === false ? 'deny' : null;
      const specific = { hookEventName: 'PreToolUse' };
      if (decision) specific.permissionDecision = decision;
      const reason = [json.agent_message, json.agentMessage, json.user_message, json.userMessage].find((item) => typeof item === 'string' && item.trim());
      if (reason) specific.permissionDecisionReason = reason;
      if (foreignEvent === 'preToolUse' && json.updated_input) {
        const updated = oasisToolInput(payload, json.updated_input);
        if (updated && updated.unsupported) messages.push('Cursor preToolUse hook: input rewrite ignored (' + updated.unsupported + ').');
        else if (updated) specific.updatedInput = updated;
      }
      return reply(out, { hookSpecificOutput: specific, ...(messages.length ? { systemMessage: messages.join('\n') } : {}) });
    }
    if (foreignEvent === 'beforeSubmitPrompt') {
      if (json.continue === false) return reply(out, { decision: 'block', reason: json.user_message || json.userMessage || 'Blocked by a Cursor beforeSubmitPrompt hook.' });
      return reply(out, null);
    }
    if (foreignEvent === 'stop' || foreignEvent === 'subagentStop') {
      const followup = typeof json.followup_message === 'string' ? json.followup_message.trim() : '';
      return reply(out, followup ? { decision: 'block', reason: followup } : null);
    }
    if (foreignEvent === 'afterAgentResponse') return reply(out, null);
    const context2 = [json.additional_context, json.additionalContext].find((item) => typeof item === 'string' && item.trim());
    if (context2 && ['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SubagentStart'].includes(event)) return reply(out, { hookSpecificOutput: { hookEventName: event, additionalContext: context2 } });
    if (foreignEvent === 'afterMCPExecution' && json.updated_mcp_tool_output !== undefined) return reply(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedMCPToolOutput: json.updated_mcp_tool_output } });
    return reply(out, null);
  }
  // Copilot CLI
  if (foreignEvent === 'preToolUse') {
    const specific = { hookEventName: 'PreToolUse' };
    if (['allow', 'deny', 'ask'].includes(json.permissionDecision)) specific.permissionDecision = json.permissionDecision;
    if (typeof json.permissionDecisionReason === 'string' && json.permissionDecisionReason.trim()) specific.permissionDecisionReason = json.permissionDecisionReason;
    let args = json.modifiedArgs ?? json.updatedInput;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { args = null; } }
    if (args && typeof args === 'object') {
      const updated = oasisToolInput(payload, args);
      if (updated && updated.unsupported) messages.push('Copilot preToolUse hook: argument rewrite ignored (' + updated.unsupported + ').');
      else if (updated) specific.updatedInput = updated;
    }
    if (typeof json.additionalContext === 'string' && json.additionalContext.trim()) specific.additionalContext = json.additionalContext;
    return reply(out, { hookSpecificOutput: specific, ...(messages.length ? { systemMessage: messages.join('\n') } : {}) });
  }
  if (foreignEvent === 'permissionRequest') {
    if (!['allow', 'deny'].includes(json.behavior)) return reply(out, null);
    return reply(out, { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: json.behavior, message: typeof json.message === 'string' ? json.message : '' } }, ...(json.behavior === 'deny' && json.interrupt === true ? { continue: false, stopReason: json.message || 'Stopped by a Copilot permissionRequest hook.' } : {}) });
  }
  if (foreignEvent === 'agentStop' || foreignEvent === 'subagentStop') {
    return reply(out, json.decision === 'block' ? { decision: 'block', reason: typeof json.reason === 'string' && json.reason.trim() ? json.reason : 'A Copilot ' + foreignEvent + ' hook asked to keep going.' } : null);
  }
  if (foreignEvent === 'postToolUse' && json.modifiedResult !== undefined) {
    const text = typeof json.modifiedResult === 'string' ? json.modifiedResult : json.modifiedResult && typeof json.modifiedResult.textResultForLlm === 'string' ? json.modifiedResult.textResultForLlm : null;
    if (text !== null) return reply(out, { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { output: text }, ...(typeof json.additionalContext === 'string' && json.additionalContext.trim() ? { additionalContext: json.additionalContext } : {}) } });
  }
  if (typeof json.additionalContext === 'string' && json.additionalContext.trim() && ['PostToolUse', 'PostToolUseFailure', 'SessionStart', 'SubagentStart', 'Notification'].includes(event)) {
    return reply(out, { hookSpecificOutput: { hookEventName: event, additionalContext: json.additionalContext } });
  }
  return reply(out, null);
}

/** Environment a bridged hook gets on top of the OASIS one. */
export function bridgeEnv(protocol, root, pluginEnv = {}) {
  const pluginRoot = pluginEnv.CLAUDE_PLUGIN_ROOT || pluginEnv.OASIS_PLUGIN_ROOT || '';
  if (protocol === 'cursor') return { CURSOR_PROJECT_DIR: root, ...(pluginRoot ? { CURSOR_PLUGIN_ROOT: pluginRoot } : {}) };
  if (protocol === 'copilot') return { ...(pluginRoot ? { COPILOT_PLUGIN_ROOT: pluginRoot } : {}) };
  return {};
}

/**
 * Runs one bridged hook. `run(command, payload, options)` is hooks.mjs's command
 * runner; it is passed in so this module has no cycle with hooks.mjs.
 */
export async function runBridgedHook(hook, payload, options, run) {
  const foreign = toForeignPayload(hook.protocol, hook.foreignEvent, payload, hook);
  if (!foreign) return { exitCode: 0, stdout: '', stderr: '', skipped: true };
  const pluginEnv = { ...(hook.env || {}), ...(hook.pluginEnv || {}), ...bridgeEnv(hook.protocol, options.root, hook.pluginEnv) };
  const out = await run(hook.command, foreign, { ...options, pluginEnv });
  return fromForeignOutput(hook.protocol, hook.foreignEvent, out, { payload });
}

/**
 * Converts one foreign hooks.json document into Claude Code hook groups tagged
 * for the bridge. Returns { hooks, dropped } where dropped lists events with no
 * OASIS moment. `rewriteCommand` makes relative script paths plugin-rooted.
 */
export function bridgeHookDoc(protocol, doc, rewriteCommand = (command) => command) {
  const table = bridgeEventTable(protocol);
  const source = doc && doc.hooks && typeof doc.hooks === 'object' && !Array.isArray(doc.hooks) ? doc.hooks : null;
  const hooks = {}, dropped = [];
  if (!table || !source) return { hooks, dropped };
  for (const [foreignEvent, entries] of Object.entries(source)) {
    const target = table[foreignEvent];
    if (!target || !Array.isArray(entries)) { dropped.push(foreignEvent); continue; }
    for (const entry of entries) {
      const hook = bridgeEntry(protocol, foreignEvent, entry, rewriteCommand);
      if (!hook) continue;
      (hooks[target.event] ||= []).push({ ...(target.matcher ? { matcher: target.matcher } : {}), hooks: [hook] });
    }
  }
  return { hooks, dropped };
}

function bridgeEntry(protocol, foreignEvent, entry, rewriteCommand) {
  if (!entry || typeof entry !== 'object') return null;
  if (entry.type && entry.type !== 'command') return null;
  let command = '', shell, prefix = '';
  if (protocol === 'cursor') command = typeof entry.command === 'string' ? entry.command : '';
  else {
    // Copilot gives one command per shell: the bash one is used, or the PowerShell one when it is the only one.
    const posix = typeof entry.bash === 'string' ? entry.bash : typeof entry.command === 'string' ? entry.command : '';
    const ps = typeof entry.powershell === 'string' ? entry.powershell : '';
    command = posix || ps;
    if (!posix && ps) shell = 'powershell';
    if (posix && typeof entry.cwd === 'string' && entry.cwd.trim() && entry.cwd.trim() !== '.') prefix = 'cd ' + rewriteCommand(entry.cwd.trim(), { path: true }) + ' && ';
  }
  if (!command.trim()) return null;
  // Copilot's default timeout is 30 seconds; Cursor's is the host's (OASIS uses its own).
  const timeout = Number(protocol === 'cursor' ? entry.timeout : entry.timeoutSec ?? entry.timeout ?? 30) || 0;
  const permission = PERMISSION_EVENTS[protocol].has(foreignEvent);
  return {
    type: 'command',
    command: prefix + (prefix ? command : rewriteCommand(command)),
    protocol,
    foreignEvent,
    ...(timeout > 0 ? { timeout } : {}),
    ...(shell ? { shell } : {}),
    ...(typeof entry.matcher === 'string' && entry.matcher.trim() ? { foreignMatcher: entry.matcher.trim() } : {}),
    // Cursor: failClosed makes a crash or timeout deny (only meaningful where a deny exists).
    ...(protocol === 'cursor' && entry.failClosed === true && permission ? { onFailure: 'block' } : {}),
    ...(protocol === 'copilot' && entry.env && typeof entry.env === 'object' ? { env: Object.fromEntries(Object.entries(entry.env).filter(([, v]) => typeof v === 'string')) } : {})
  };
}
