// `oasis exec --json` (alias --experimental-json): the Codex CLI `codex exec --json`
// JSONL event stream, so the OpenAI Codex SDK (@openai/codex-sdk, which spawns
// `codex exec --experimental-json`) can drive OASIS through `codexPathOverride`.
//
// Events (one JSON object per line on stdout):
//   thread.started {thread_id}  turn.started  item.started|item.updated|item.completed {item}
//   turn.completed {usage}  turn.failed {error:{message}}  error {message}
// Items (snake_case, Codex exec shape): agent_message, reasoning, command_execution,
// file_change, mcp_tool_call, web_search, todo_list, error.
//
// OASIS tools without a Codex equivalent (read_file, grep, task, ...) are reported
// as mcp_tool_call items with server "oasis", so SDK consumers see every step.
import { EXECUTE_TOOLS, FILE_TOOLS, commandText, resultText, isFailure, toolPaths, readSmall } from './codex-app-server.mjs';

const MAX_OUTPUT = 100_000;

export function createCodexExecJsonStream({ write, root, threadId = null } = {}) {
  let counter = 0;
  const nextId = () => 'item_' + (counter++);
  const open = new Map();
  let session = null;
  let todo = null;
  let started = false;
  let finished = false;
  const out = (event) => write(JSON.stringify(event) + '\n');

  const mcpName = (name) => {
    const mapped = session && session.mcpToolMap && session.mcpToolMap.get(name);
    if (mapped && !mapped.resourceTool) return { server: String(mapped.serverName || 'mcp'), tool: String(mapped.toolName || name) };
    const claude = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(name);
    if (claude) return { server: claude[1], tool: claude[2] };
    return null;
  };

  const start = (id) => {
    if (started) return;
    started = true;
    out({ type: 'thread.started', thread_id: id || threadId || '' });
    out({ type: 'turn.started' });
  };

  const todoItems = (todos) => (Array.isArray(todos) ? todos : []).slice(0, 50).map((entry) => ({ text: String(entry && (entry.content || entry.activeForm) || ''), completed: Boolean(entry && entry.status === 'completed') }));

  const toolStart = ({ name, args = {}, call }) => {
    start(null);
    const key = call && call.id ? String(call.id) : null;
    const id = nextId();
    let item = null;
    const before = new Map();
    if (name === 'todo_write') {
      if (!todo) { todo = { id, items: todoItems(args.todos) }; out({ type: 'item.started', item: { type: 'todo_list', ...todo } }); }
      else { todo.items = todoItems(args.todos); out({ type: 'item.updated', item: { type: 'todo_list', ...todo } }); }
      return;
    }
    if (EXECUTE_TOOLS.has(name)) item = { id, type: 'command_execution', command: commandText(name, args), aggregated_output: '', status: 'in_progress' };
    else if (FILE_TOOLS.has(name)) {
      for (const file of toolPaths(root, name, args)) before.set(file, readSmall(file));
      // Codex emits file_change only once the patch is applied.
    } else if (name === 'web_search') item = { id, type: 'web_search', query: String(args.query || args.q || '') };
    else {
      const mcp = mcpName(name);
      item = { id, type: 'mcp_tool_call', server: mcp ? mcp.server : 'oasis', tool: mcp ? mcp.tool : name, arguments: args, status: 'in_progress' };
    }
    if (item) out({ type: 'item.started', item });
    open.set(key || id, { id, name, item, before, done: false });
  };

  const toolResult = ({ name, result, call }) => {
    if (name === 'todo_write') return;
    const key = call && call.id && open.has(String(call.id)) ? String(call.id) : [...open.keys()].find((candidate) => !open.get(candidate).done && open.get(candidate).name === name);
    const record = key && open.get(key);
    if (!record) return;
    record.done = true;
    open.delete(key);
    // A declined approval comes back as a plain sentence, not an error object.
    const failed = isFailure(result) || (result && typeof result === 'object' && result.approved === false) || (typeof result === 'string' && /^(Command was not approved|Permission denied|Denied\b)|was not approved/i.test(result));
    let item = record.item;
    if (FILE_TOOLS.has(name)) {
      const changes = [...record.before.entries()].map(([file, oldText]) => {
        const newText = readSmall(file);
        const kind = oldText === null && newText !== null ? 'add' : oldText !== null && newText === null ? 'delete' : 'update';
        return { path: file, kind };
      });
      item = { id: record.id, type: 'file_change', changes, status: failed ? 'failed' : 'completed' };
    } else if (item.type === 'command_execution') {
      item = { ...item, aggregated_output: resultText(result).slice(-MAX_OUTPUT), status: failed ? 'failed' : 'completed', ...(result && typeof result.exitCode === 'number' ? { exit_code: result.exitCode } : {}) };
    } else if (item.type === 'mcp_tool_call') {
      item = failed
        ? { ...item, status: 'failed', error: { message: resultText(result).slice(0, 20_000) } }
        : { ...item, status: 'completed', result: { content: [{ type: 'text', text: resultText(result).slice(0, MAX_OUTPUT) }], structured_content: result && typeof result === 'object' && !Array.isArray(result) ? result : null } };
    }
    out({ type: 'item.completed', item });
  };

  let lastText = null;
  const onEvent = (event) => {
    if (!event || typeof event !== 'object' || finished) return;
    if (event.type === 'system' && event.subtype === 'init') { start(event.session_id); return; }
    if (event.type === 'assistant' && typeof event.text === 'string' && event.text.trim()) {
      start(null);
      lastText = event.text;
      out({ type: 'item.completed', item: { id: nextId(), type: 'agent_message', text: event.text } });
      return;
    }
    if (event.type === 'system' && event.subtype === 'permission' && event.allowed === false) {
      start(null);
      out({ type: 'item.completed', item: { id: nextId(), type: 'error', message: 'Permission denied for ' + (event.tool || 'a tool') + ' (no approvals in exec mode; allow it with a permission rule, --full-auto or --sandbox).' } });
      return;
    }
    if (event.type === 'result' && event.subtype !== 'turn') {
      start(event.session_id);
      finished = true;
      if (todo) out({ type: 'item.completed', item: { type: 'todo_list', ...todo } });
      for (const record of open.values()) if (record.item) out({ type: 'item.completed', item: { ...record.item, status: 'failed' } });
      open.clear();
      // With --output-schema the final message is the JSON document, as in Codex.
      if (event.structured_output !== undefined) {
        const text = JSON.stringify(event.structured_output);
        if (text !== lastText) out({ type: 'item.completed', item: { id: nextId(), type: 'agent_message', text } });
      }
      if (event.is_error) {
        const message = String(event.result || event.subtype || 'turn failed');
        out({ type: 'turn.failed', error: { message: event.subtype && event.subtype !== 'error_during_execution' ? event.subtype + ': ' + message : message } });
      } else {
        const usage = event.usage || {};
        out({ type: 'turn.completed', usage: {
          input_tokens: Number(usage.input_tokens) || 0,
          cached_input_tokens: Number(usage.cache_read_input_tokens || usage.cached_input_tokens) || 0,
          cache_write_input_tokens: Number(usage.cache_creation_input_tokens || usage.cache_write_input_tokens) || 0,
          output_tokens: Number(usage.output_tokens) || 0,
          reasoning_output_tokens: Number(usage.reasoning_tokens || usage.reasoning_output_tokens) || 0
        } });
      }
    }
  };

  return {
    onEvent,
    onSession: (value) => { session = value; },
    toolObserver: { start: toolStart, result: toolResult },
    // Setup failures (no provider, bad flags) still produce a parseable stream.
    fail(message) {
      if (finished) return;
      finished = true;
      out({ type: 'error', message: String(message) });
    },
    get finished() { return finished; }
  };
}

// Codex `-c/--config key=value` (TOML value) → plain JS value.
export function parseCodexConfigValue(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (/^(true|false)$/.test(text)) return text === 'true';
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text);
  if (/^"(.*)"$/s.test(text)) { try { return JSON.parse(text); } catch { return text.slice(1, -1); } }
  if (/^'(.*)'$/s.test(text)) return text.slice(1, -1);
  if (/^[[{]/.test(text)) { try { return JSON.parse(text); } catch {} }
  return text;
}

// Codex reasoning effort → OASIS --effort level.
export function codexEffort(value) {
  const level = String(value || '').toLowerCase();
  if (level === 'minimal' || level === 'low' || level === 'none') return 'low';
  if (level === 'medium') return 'medium';
  if (level === 'high') return 'high';
  if (level === 'xhigh') return 'max';
  return null;
}

