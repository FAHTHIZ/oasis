// Claude Code-compatible status line: settings.statusLine = { type: 'command', command }.
// The command gets session JSON on stdin; the first line of its output is shown
// above the input prompt. Only trusted workspaces (or user settings) can set it.
import { runHookCommand } from './hooks.mjs';

const ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]/g;

export function statusLinePayload({ root, session = null, config = {}, usage = null, outputStyle = null }) {
  const model = session && session.config && session.config.model || config.model || '';
  return {
    hook_event_name: 'Status',
    session_id: session && session.sessionId || null,
    cwd: root,
    workspace: { current_dir: root, project_dir: root },
    model: { id: model, display_name: model },
    output_style: { name: session && session.outputStyle || outputStyle || 'default' },
    permission_mode: session && session.permissions && session.permissions.mode || 'default',
    cost: usage ? { total_tokens: usage.totalTokens, input_tokens: usage.inputTokens, output_tokens: usage.outputTokens, requests: usage.requests } : {},
    context: session ? { messages: session.messages.length } : { messages: 0 }
  };
}

export async function renderStatusLine(statusLine, payload, options = {}) {
  if (!statusLine || statusLine.type !== 'command' || !statusLine.command) return null;
  const result = await runHookCommand(statusLine.command, payload, { root: options.root, env: options.env, timeout: 5 });
  if (result.exitCode !== 0 || result.timedOut) return null;
  const firstLine = String(result.stdout || '').split(/\r?\n/).find((line) => line.trim()) || '';
  // Keep color codes only on a real terminal; always drop other control characters.
  let cleaned = options.keepColor ? firstLine : firstLine.replace(ANSI, '');
  cleaned = cleaned.replace(options.keepColor ? /[\x00-\x08\x0b-\x1a\x1c-\x1f\x7f]/g : /[\x00-\x08\x0b-\x1f\x7f]/g, '');
  return cleaned.slice(0, 400) || null;
}

// Claude Code's subagentStatusLine = { type: 'command', command }: one run per refresh gets
// every visible subagent row ({ ...base fields, columns, tasks: [...] } on stdin) and may
// print {"id", "content"} lines. A row it names shows `content` instead of OASIS's own text
// ("" hides the row); rows it leaves out keep the default.
export function subagentStatusLinePayload({ root, session = null, records = [], columns = 100, env = process.env, contextWindowSize = null, contextTokens = null }) {
  const tasks = [];
  for (const record of records) {
    const child = record.child || {};
    const config = child.config || {};
    const usageTokens = record.usage ? Number(record.usage.totalTokens || (Number(record.usage.inputTokens || 0) + Number(record.usage.outputTokens || 0))) : 0;
    let tokenCount = 0;
    try { tokenCount = contextTokens && Array.isArray(child.messages) ? contextTokens(child).tokens : 0; } catch { tokenCount = 0; }
    tokenCount = Math.max(0, Math.round(tokenCount || usageTokens || Number(record.tokensUsed) || 0));
    // One reading per refresh, at most 16, oldest first.
    const samples = Array.isArray(record.tokenSamples) ? record.tokenSamples : [];
    samples.push(tokenCount);
    while (samples.length > 16) samples.shift();
    Object.defineProperty(record, 'tokenSamples', { value: samples, writable: true, configurable: true, enumerable: false });
    const description = String(record.description || record.type || record.id);
    const task = {
      id: record.id,
      ...(record.name ? { name: String(record.name) } : {}),
      type: 'local_agent',
      agentType: String(record.type || 'general-purpose'),
      status: String(record.status || 'running'),
      description,
      label: String(record.label || (Array.isArray(record.recentTools) && record.recentTools.length ? record.recentTools[record.recentTools.length - 1] : '') || description),
      startTime: Number(record.startedAt) || Date.now(),
      tokenCount,
      tokenSamples: [...samples],
      cwd: String(child.root || (record.worktreeInfo && record.worktreeInfo.path) || root)
    };
    if (typeof config.model === 'string' && config.model) {
      task.model = config.model;
      try { const size = contextWindowSize ? contextWindowSize(config, env) : 0; if (size) task.contextWindowSize = size; } catch {}
    }
    const effort = config.effort || config.reasoningEffort;
    if (effort) task.effort = effort;
    tasks.push(task);
  }
  return {
    hook_event_name: 'SubagentStatus',
    session_id: session && session.sessionId || null,
    transcript_path: session && session.transcriptPath || null,
    cwd: root,
    permission_mode: session && session.permissions && session.permissions.mode || 'default',
    columns: Math.max(20, Number(columns) || 100),
    tasks
  };
}

/** Map of task id -> row content from the subagentStatusLine command (empty map on failure). */
export async function renderSubagentStatusLines(setting, payload, options = {}) {
  const rows = new Map();
  if (!setting || setting.type !== 'command' || !setting.command || !payload.tasks.length) return rows;
  const result = await runHookCommand(setting.command, payload, { root: options.root, env: options.env, timeout: 5 });
  if (result.exitCode !== 0 || result.timedOut) return rows;
  const ids = new Set(payload.tasks.map((task) => task.id));
  for (const line of String(result.stdout || '').split(/\r?\n/).slice(0, 500)) {
    if (!line.trim()) continue;
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    if (!item || typeof item.id !== 'string' || !ids.has(item.id) || typeof item.content !== 'string') continue;
    let content = options.keepColor ? item.content : item.content.replace(ANSI, '');
    // OSC 8 hyperlinks stay on a real terminal; other control characters (and newlines) go.
    if (!options.keepColor) content = content.replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
    content = content.replace(options.keepColor ? /[\x00-\x06\x08-\x1a\x1c-\x1f\x7f]/g : /[\x00-\x1f\x7f]/g, '');
    rows.set(item.id, content.slice(0, 400));
  }
  return rows;
}
