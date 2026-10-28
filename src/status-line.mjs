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
