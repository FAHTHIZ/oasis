// Lifecycle hooks compatible with Claude Code's settings.json "hooks" format.
//
// Events: PreToolUse, PostToolUse, UserPromptSubmit, Stop, SubagentStop,
// SessionStart, SessionEnd, PreCompact, Notification.
// Each hook is a user-configured shell command. It receives a JSON payload on
// stdin and controls Oasis through its exit code and optional JSON stdout:
//   exit 0  success; stdout JSON may carry decision/permissionDecision/additionalContext
//   exit 2  blocking error; stderr is fed back to the model (PreToolUse blocks the tool,
//           UserPromptSubmit drops the prompt, Stop forces the agent to keep working)
//   other   non-blocking error; shown to the user, execution continues
// Hooks come from user settings or trusted workspaces only (see settings.mjs).
import { spawn } from 'node:child_process';

export const HOOK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'Stop', 'SubagentStop', 'SessionStart', 'SessionEnd', 'PreCompact', 'Notification'];

// Claude Code tool names, so matchers such as "Edit|Write" or "Bash" keep working.
export const CLAUDE_TOOL_NAMES = {
  run_command: 'Bash', run_shell: 'Bash', edit_file: 'Edit', multi_edit: 'MultiEdit', notebook_edit: 'NotebookEdit', write_file: 'Write',
  read_file: 'Read', glob_files: 'Glob', grep: 'Grep', search_files: 'Grep', list_files: 'LS',
  fetch_url: 'WebFetch', web_search: 'WebSearch', task: 'Task', todo_write: 'TodoWrite', delete_file: 'Delete',
  command_output: 'BashOutput', kill_command: 'KillShell', lsp: 'LSP'
};

const MAX_HOOK_OUTPUT = 64 * 1024;

function matcherAccepts(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  if (!toolName) return true;
  const names = [toolName, CLAUDE_TOOL_NAMES[toolName]].filter(Boolean);
  let regex;
  try { regex = new RegExp('^(?:' + matcher + ')$'); } catch { return names.includes(matcher); }
  return names.some((name) => regex.test(name));
}

function hookEnvironment(baseEnv, root) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || process.env)) {
    if (/(?:API[_-]?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|PRIVATE[_-]?KEY|AUTHORIZATION)/i.test(key)) continue;
    env[key] = value;
  }
  env.OASIS_PROJECT_DIR = root;
  env.CLAUDE_PROJECT_DIR = root;
  return env;
}

export function runHookCommand(command, payload, options = {}) {
  const timeoutMs = Math.max(1, Math.min(600, Number(options.timeout) || 60)) * 1000;
  const shell = process.platform === 'win32' ? { cmd: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', command] } : { cmd: '/bin/sh', args: ['-c', command] };
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(shell.cmd, shell.args, { cwd: options.root, env: hookEnvironment(options.env, options.root), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ exitCode: null, stdout, stderr: stderr + '\nHook timed out.', timedOut: true }); }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(0, MAX_HOOK_OUTPUT); });
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(0, MAX_HOOK_OUTPUT); });
    child.on('error', (error) => finish({ exitCode: null, stdout, stderr: error.message }));
    child.on('close', (code) => finish({ exitCode: code, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

function parseJsonOutput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed.startsWith('{')) return null;
  try { return JSON.parse(trimmed); } catch { return null; }
}

// Runs every matching hook for an event and folds their results.
export async function runHooks(event, payload, options = {}) {
  const hooks = options.hooks || {};
  const groups = Array.isArray(hooks[event]) ? hooks[event] : [];
  const result = { ran: 0, blocked: false, reason: '', additionalContext: [], permissionDecision: null, stopContinuation: false, messages: [], updatedInput: null };
  if (!groups.length) return result;
  const toolName = payload && payload.tool_name_oasis;
  const commands = [];
  for (const group of groups) {
    if (event === 'PreToolUse' || event === 'PostToolUse') { if (!matcherAccepts(group.matcher, toolName)) continue; }
    else if (group.matcher && event === 'SessionStart' && payload.source && !matcherAccepts(group.matcher, payload.source)) continue;
    for (const hook of group.hooks) commands.push(hook);
  }
  if (!commands.length) return result;
  const fullPayload = { ...payload, hook_event_name: event, cwd: options.root };
  delete fullPayload.tool_name_oasis;
  // Claude Code runs matching hooks in parallel.
  const outputs = await Promise.all(commands.map((hook) => runHookCommand(hook.command, fullPayload, { root: options.root, env: options.env, timeout: hook.timeout })));
  for (let i = 0; i < outputs.length; i++) {
    const out = outputs[i];
    result.ran++;
    if (out.exitCode === 2) {
      result.blocked = true;
      result.reason += (result.reason ? '\n' : '') + (out.stderr.trim() || 'Blocked by ' + event + ' hook.');
      continue;
    }
    if (out.exitCode !== 0) {
      result.messages.push(event + ' hook failed (' + (out.timedOut ? 'timeout' : 'exit ' + out.exitCode) + '): ' + (out.stderr.trim() || commands[i].command).slice(0, 500));
      continue;
    }
    const json = parseJsonOutput(out.stdout);
    if (json) {
      if (json.continue === false) { result.blocked = true; result.stopContinuation = true; result.reason += (result.reason ? '\n' : '') + (json.stopReason || 'Stopped by hook.'); }
      if (json.decision === 'block') { result.blocked = true; result.reason += (result.reason ? '\n' : '') + (json.reason || 'Blocked by hook.'); }
      if (json.decision === 'approve' && !result.permissionDecision) result.permissionDecision = 'allow';
      const specific = json.hookSpecificOutput && typeof json.hookSpecificOutput === 'object' ? json.hookSpecificOutput : {};
      const decision = specific.permissionDecision;
      if (['allow', 'deny', 'ask'].includes(decision)) {
        const rank = { deny: 3, ask: 2, allow: 1 };
        if (!result.permissionDecision || rank[decision] > rank[result.permissionDecision]) result.permissionDecision = decision;
        if (decision === 'deny') result.reason += (result.reason ? '\n' : '') + (specific.permissionDecisionReason || 'Denied by PreToolUse hook.');
      }
      if (specific.updatedInput && typeof specific.updatedInput === 'object') result.updatedInput = specific.updatedInput;
      if (typeof specific.additionalContext === 'string' && specific.additionalContext.trim()) result.additionalContext.push(specific.additionalContext.trim());
      if (typeof json.systemMessage === 'string') result.messages.push(json.systemMessage);
    } else if ((event === 'UserPromptSubmit' || event === 'SessionStart') && out.stdout.trim()) {
      result.additionalContext.push(out.stdout.trim().slice(0, 10000));
    }
  }
  return result;
}

export function hasHooks(hooks, event) {
  return Boolean(hooks && Array.isArray(hooks[event]) && hooks[event].length);
}
