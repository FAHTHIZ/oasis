// Trajectory export and batch runs, for evaluation and fine-tuning datasets.
//
//   oasis sessions export [ID...|--all] [--verified] [--format openai|sharegpt|hermes] [--out FILE] [--compress [TOKENS]]
//   oasis batch PROMPTS.jsonl [--out FILE] [--format openai|sharegpt|hermes] [--concurrency N] [--compress [TOKENS]]
//
// --compress cuts each trajectory to TOKENS (default 15250) the way Hermes'
// trajectory compressor does (see trajectory-compress.mjs); --summary-tokens N,
// --keep-last N and --metrics FILE tune and report it.
//
// Export writes one JSON object per line. "openai" keeps the chat-completions
// message list (system, user, assistant with tool_calls, tool) plus the tool
// schemas; "sharegpt" maps it to {from: system|human|gpt|function_call|observation, value}.
// Secrets are redacted with the same patterns as auto memory.
// --verified keeps only sessions whose audit trail ends in a passing check
// (see sessionVerified).
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './auto-memory.mjs';
import { redactAuditValue } from './tool-kernel.mjs';
import { FILE_EDITING_TOOL_NAMES } from './turn-guards.mjs';

// Tool-call arguments arrive as JSON text; redact the decoded strings so
// multi-line values (a .env body) are matched line by line.
const decoded = (value) => { if (typeof value !== 'string' || !/^\s*[[{]/.test(value)) return value; try { return JSON.parse(value); } catch { return value; } };
const clean = (value) => { const data = decoded(value); return redactSecrets(data === null || data === undefined ? '' : typeof data === 'string' ? redactAuditValue(data) : JSON.stringify(redactAuditValue(data))).text; };

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part && typeof part.text === 'string' ? part.text : '').join('');
  return content === null || content === undefined ? '' : JSON.stringify(content);
}

export function toOpenAIRecord(data, tools = []) {
  const messages = [];
  for (const message of data.messages || []) {
    if (!message || !['system', 'user', 'assistant', 'tool'].includes(message.role)) continue;
    const item = { role: message.role, content: clean(contentText(message.content)) };
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      item.tool_calls = message.tool_calls.map((call) => ({ id: String(call.id || ''), type: 'function', function: { name: String(call.function && call.function.name || ''), arguments: clean(call.function && call.function.arguments || '{}') } }));
    }
    if (message.role === 'assistant') { const reasoning = typeof message.reasoning_content === 'string' ? message.reasoning_content : typeof message.reasoning === 'string' ? message.reasoning : ''; if (reasoning.trim()) item.reasoning_content = clean(reasoning); }
    if (message.role === 'tool') { item.tool_call_id = String(message.tool_call_id || ''); if (message.name) item.name = String(message.name); }
    messages.push(item);
  }
  return { id: data.id || null, model: data.model || (data.provider && data.provider.model) || (data.config && data.config.model) || null, messages, tools: tools.map((tool) => tool && tool.function ? { type: 'function', function: { name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters } } : tool).filter(Boolean), metadata: { source: 'oasis', updatedAt: data.updatedAt || null, workspace: data.workspaceRoot ? path.basename(data.workspaceRoot) : null } };
}

export function toShareGPTRecord(data, tools = []) {
  return shareGPTFromRecord(toOpenAIRecord(data, tools));
}

export function shareGPTFromRecord(record) {
  const conversations = [];
  for (const message of record.messages) {
    if (message.role === 'system') conversations.push({ from: 'system', value: message.content });
    else if (message.role === 'user') conversations.push({ from: 'human', value: message.content });
    else if (message.role === 'assistant') {
      if (message.content) conversations.push({ from: 'gpt', value: message.content });
      for (const call of message.tool_calls || []) {
        let args = call.function.arguments;
        try { args = JSON.parse(args); } catch {}
        conversations.push({ from: 'function_call', value: JSON.stringify({ name: call.function.name, arguments: args }) });
      }
    } else if (message.role === 'tool') conversations.push({ from: 'observation', value: message.content });
  }
  return { id: record.id, conversations, tools: JSON.stringify(record.tools.map((tool) => tool.function || tool)), metadata: record.metadata, ...(record.compression_metrics ? { compression_metrics: record.compression_metrics } : {}) };
}

// Hermes function-calling layout (the format Nous Research trains Hermes models
// on, as written by Hermes Agent): a generated system turn listing the tools in
// <tools>, gpt turns with a <think> block and <tool_call> JSON, and the results of
// one assistant turn grouped into a single tool turn of <tool_response> blocks.
export const HERMES_SYSTEM_PREFIX = 'You are a function calling AI model. You are provided with function signatures within <tools> </tools> XML tags. You may call one or more functions to assist with the user query. If available tools are not relevant in assisting with user query, just respond in natural conversational language.\n\nDon\'t make assumptions about what values to plug into functions. After calling & executing the functions, you will be provided with function results within <tool_response> </tool_response> XML tags.\n\n';
const HERMES_SYSTEM_SUFFIX = '\nFor each function call return a JSON object, with the following pydantic model json schema for each:\n{\'title\': \'FunctionCall\', \'type\': \'object\', \'properties\': {\'name\': {\'title\': \'Name\', \'type\': \'string\'}, \'arguments\': {\'title\': \'Arguments\', \'type\': \'object\'}}, \'required\': [\'name\', \'arguments\']}\nEach function call should be enclosed within <tool_call> </tool_call> XML tags.\nExample:\n<tool_call>\n{\'name\': <function-name>,\'arguments\': <args-dict>}\n</tool_call>';

export function hermesSystemPrompt(tools = []) {
  const listed = tools.map((tool) => tool && tool.function ? tool.function : tool).filter((tool) => tool && tool.name).map((tool) => ({ name: tool.name, description: tool.description || '', parameters: tool.parameters || { type: 'object', properties: {} }, required: null }));
  return HERMES_SYSTEM_PREFIX + 'Here are the available tools:\n<tools>\n' + pyJson(listed) + '\n</tools>' + HERMES_SYSTEM_SUFFIX;
}

// Python json.dumps spacing (", " and ": "), as in Hermes Agent's own files.
export function pyJson(value) {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return '[' + value.map(pyJson).join(', ') + ']';
  if (typeof value === 'object') return '{' + Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => JSON.stringify(key) + ': ' + pyJson(item)).join(', ') + '}';
  if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
  return JSON.stringify(value);
}

const jsonish = (text) => { if (typeof text !== 'string' || !/^\s*[[{]/.test(text)) return text; try { return JSON.parse(text); } catch { return text; } };

function toolFailed(content) {
  const value = jsonish(content);
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && (value.ok === false || (typeof value.error === 'string' && value.error && value.ok !== true)));
}

/** Per-tool call counts with successes and failures, for every tool in the list (zero when unused). */
export function hermesToolStats(record) {
  const stats = {};
  for (const tool of record.tools || []) { const name = tool.function ? tool.function.name : tool.name; if (name) stats[name] = { count: 0, success: 0, failure: 0 }; }
  const names = new Map();
  for (const message of record.messages) for (const call of message.tool_calls || []) names.set(call.id, call.function.name);
  for (const message of record.messages) {
    if (message.role !== 'tool') continue;
    const name = message.name || names.get(message.tool_call_id) || 'unknown';
    const entry = stats[name] || (stats[name] = { count: 0, success: 0, failure: 0 });
    entry.count++;
    if (toolFailed(message.content)) entry.failure++; else entry.success++;
  }
  return stats;
}

export function hermesFromRecord(record, { completed = true } = {}) {
  const conversations = [{ from: 'system', value: hermesSystemPrompt(record.tools) + (record.compression_metrics ? '\n\nSome of your previous tool responses may be summarized to preserve context.' : '') }];
  const names = new Map();
  for (let index = 0; index < record.messages.length; index++) {
    const message = record.messages[index];
    if (message.role === 'system') continue;
    if (message.role === 'user') { conversations.push({ from: 'human', value: message.content }); continue; }
    if (message.role === 'assistant') {
      let value = '<think>\n' + String(message.reasoning_content || '').trim() + (message.reasoning_content ? '\n' : '') + '</think>\n' + (message.content || '');
      for (const call of message.tool_calls || []) {
        names.set(call.id, call.function.name);
        let args = {};
        try { args = JSON.parse(call.function.arguments || '{}'); } catch { args = {}; }
        value += (value.endsWith('\n') ? '' : '\n') + '<tool_call>\n' + pyJson({ name: call.function.name, arguments: args }) + '\n</tool_call>';
      }
      conversations.push({ from: 'gpt', value });
      continue;
    }
    if (message.role === 'tool') {
      const responses = [];
      while (index < record.messages.length && record.messages[index].role === 'tool') {
        const result = record.messages[index];
        responses.push('<tool_response>\n' + pyJson({ tool_call_id: result.tool_call_id, name: result.name || names.get(result.tool_call_id) || '', content: jsonish(result.content) }) + '\n</tool_response>');
        index++;
      }
      index--;
      conversations.push({ from: 'tool', value: responses.join('\n') });
    }
  }
  const stats = hermesToolStats(record);
  const errors = Object.fromEntries(Object.entries(stats).map(([name, entry]) => [name, entry.failure]));
  return {
    id: record.id, conversations, timestamp: record.metadata && record.metadata.updatedAt || new Date().toISOString(), model: record.model, completed,
    api_calls: record.messages.filter((message) => message.role === 'assistant').length,
    tool_stats: stats, tool_error_counts: errors, metadata: record.metadata,
    ...(record.compression_metrics ? { compression_metrics: record.compression_metrics } : {})
  };
}

export const EXPORT_FORMATS = ['openai', 'sharegpt', 'hermes'];

function formatRecord(data, format = 'openai', tools = []) {
  if (format === 'hermes') return hermesFromRecord(toOpenAIRecord(data, tools));
  if (format === 'sharegpt') return toShareGPTRecord(data, tools);
  if (format === 'openai') return toOpenAIRecord(data, tools);
  throw new Error('Unknown export format ' + format + '. Use openai, sharegpt or hermes.');
}

function option(args, name, fallback = null) {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : fallback;
}

const NUMBER = /^\d+$/;

// --compress [TOKENS] (the number is optional), --summary-tokens N, --keep-last N, --metrics FILE.
export function compressionOptions(args = []) {
  const at = args.indexOf('--compress');
  if (at < 0) return null;
  const next = args[at + 1];
  const numeric = (name) => { const value = option(args, name); if (value === null) return undefined; if (!NUMBER.test(value)) throw new Error(name + ' needs a whole number.'); return Number(value); };
  return {
    targetTokens: next && NUMBER.test(next) ? Number(next) : undefined,
    summaryTokens: numeric('--summary-tokens'),
    keepLast: numeric('--keep-last'),
    metricsFile: option(args, '--metrics')
  };
}

// Values that belong to flags, so they are not taken for session IDs or the prompt file.
function flagValues(args) {
  const values = new Set();
  for (const name of ['--format', '--out', '--concurrency', '--summary-tokens', '--keep-last', '--metrics']) { const value = option(args, name); if (value) values.add(value); }
  const at = args.indexOf('--compress');
  if (at >= 0 && args[at + 1] && NUMBER.test(args[at + 1])) values.add(args[at + 1]);
  return values;
}

async function compressor(compress, options, env) {
  if (!compress) return null;
  const tools = await import('./trajectory-compress.mjs');
  const summarize = options.summarize !== undefined ? options.summarize : await tools.providerSummarizer({ env, config: options.config || null }).catch(() => null);
  const totals = tools.newCompressionTotals();
  return {
    async apply(record) {
      try {
        const { messages, metrics } = await tools.compressMessages(record.messages, { ...compress, summarize });
        tools.addCompressionMetrics(totals, metrics);
        return metrics.was_compressed ? { ...record, messages: messages.map((message) => message.role === 'user' && typeof message.content === 'string' ? { ...message, content: clean(message.content) } : message), compression_metrics: metrics } : record;
      } catch {
        tools.addCompressionMetrics(totals, null);
        return record;
      }
    },
    async finish() {
      const report = tools.compressionReport(totals);
      if (compress.metricsFile) { const { writeFile } = await import('node:fs/promises'); await writeFile(compress.metricsFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
      if (options.onCompression) options.onCompression(report);
      return report;
    }
  };
}

/** One line for stderr after a compressed export. */
export function compressionLine(report) {
  const { summary, tokens } = report;
  return 'Compressed ' + summary.trajectories_compressed + ' of ' + summary.total_trajectories + ' trajectories (' + tokens.total_before + ' -> ' + tokens.total_after + ' tokens, ratio ' + tokens.overall_compression_ratio + ')' + (summary.trajectories_still_over_limit ? '; ' + summary.trajectories_still_over_limit + ' still over the limit' : '') + (report.summarization.total_errors ? '; ' + report.summarization.total_errors + ' summaries failed and used the fixed notice' : '') + '.';
}

// Saved sessions do not store tool schemas; use the built-in definitions for the tools a run called.
async function usedToolDefinitions(messages) {
  const used = new Set();
  for (const message of messages || []) for (const call of (message && message.tool_calls) || []) if (call && call.function && call.function.name) used.add(call.function.name);
  if (!used.size) return [];
  const { TOOL_DEFINITIONS } = await import('./tools.mjs');
  const known = new Map(TOOL_DEFINITIONS.map((tool) => [tool.function.name, tool]));
  return [...used].map((name) => known.get(name) || { type: 'function', function: { name, description: '', parameters: { type: 'object', properties: {} } } });
}

async function formatWith(data, format, tools, squeeze, { completed = true } = {}) {
  let record = toOpenAIRecord(data, format === 'hermes' && !tools.length ? await usedToolDefinitions(data.messages) : tools);
  if (squeeze) record = await squeeze.apply(record);
  if (format === 'hermes') return hermesFromRecord(record, { completed });
  return format === 'sharegpt' ? shareGPTFromRecord(record) : record;
}

function openOut(file, stdout) {
  if (!file || file === '-') return { write: (line) => stdout.write(line), close: async () => {} };
  const stream = createWriteStream(file, { flags: 'w', mode: 0o600 });
  return { write: (line) => stream.write(line), close: () => new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve())) };
}

// A session counts as verified when its event log records at least one
// verification command (tests, build, lint, type check), the last one passed,
// and no file was edited after it. A session that never ran a check, or ended
// on a failing one or on unchecked edits, is not exported with --verified.
export function sessionVerified(events = []) {
  let lastCheck = -1;
  for (let index = 0; index < events.length; index++) if (events[index] && events[index].type === 'verification') lastCheck = index;
  if (lastCheck < 0 || events[lastCheck].passed !== true) return false;
  return !events.slice(lastCheck + 1).some((event) => event && event.type === 'tool_result' && event.ok !== false && FILE_EDITING_TOOL_NAMES.has(event.tool));
}

export async function exportSessions(root, args = [], options = {}) {
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const format = option(args, '--format', 'openai');
  formatRecord({ messages: [] }, format);
  const { listSessions, loadSession } = await import('./sessions.mjs');
  const values = flagValues(args);
  const squeeze = await compressor(compressionOptions(args), options, env);
  let ids = args.filter((arg) => !arg.startsWith('--') && !values.has(arg));
  if (args.includes('--all') || !ids.length) {
    if (!args.includes('--all')) throw new Error('Usage: oasis sessions export SESSION_ID... | --all [--verified] [--format openai|sharegpt|hermes] [--out FILE] [--compress [TOKENS]]');
    ids = (await listSessions(root, { env })).map((item) => item.id);
  }
  const out = openOut(option(args, '--out'), stdout);
  const verifiedOnly = args.includes('--verified');
  const { readEvents } = verifiedOnly ? await import('./event-stream.mjs') : {};
  let count = 0;
  let skipped = 0;
  for (const id of ids) {
    const data = await loadSession(root, id, { env });
    if (verifiedOnly && !sessionVerified(await readEvents(root, data.id || id, { env }))) { skipped++; continue; }
    out.write(JSON.stringify(await formatWith({ ...data, id: data.id || id }, format, [], squeeze)) + '\n');
    count++;
  }
  await out.close();
  if (squeeze) await squeeze.finish();
  if (options.onSkipped) options.onSkipped(skipped);
  return count;
}

export async function parsePromptFile(file) {
  const text = await readFile(file, 'utf8');
  const prompts = [];
  text.split(/\r?\n/).forEach((line, index) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//')) return;
    let entry;
    try { entry = JSON.parse(trimmed); } catch { entry = { prompt: trimmed }; }
    if (typeof entry === 'string') entry = { prompt: entry };
    if (!entry || typeof entry.prompt !== 'string' || !entry.prompt.trim()) throw new Error(file + ':' + (index + 1) + ': each line needs a "prompt" string (or plain text).');
    prompts.push({ id: entry.id === undefined ? String(prompts.length + 1) : String(entry.id), prompt: entry.prompt, metadata: entry.metadata && typeof entry.metadata === 'object' ? entry.metadata : undefined });
  });
  return prompts;
}

// Runs every prompt in a fresh session (sequentially by default) and writes
// one line per prompt: { id, prompt, ok, text, toolCalls, durationMs, trajectory }.
// Approvals follow the permission mode; anything that would prompt is denied.
export async function runBatch(root, args = [], options = {}) {
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const stderr = options.stderr || process.stderr;
  const values = flagValues(args);
  const file = args.find((arg) => !arg.startsWith('--') && !values.has(arg));
  if (!file) throw new Error('Usage: oasis batch PROMPTS.jsonl [--out FILE] [--format openai|sharegpt|hermes] [--concurrency N] [--compress [TOKENS]]');
  const format = option(args, '--format', 'openai');
  formatRecord({ messages: [] }, format);
  const concurrency = Math.min(8, Math.max(1, Number.parseInt(option(args, '--concurrency', '1'), 10) || 1));
  const prompts = await parsePromptFile(path.resolve(root, file));
  const agent = options.agent || await import('./agent.mjs');
  const { loadConfig } = options.configModule || await import('./config.mjs');
  const config = options.config || await loadConfig({ env });
  if (!config.configured) throw new Error('No model provider is configured. Run `oasis setup` first.');
  const compress = compressionOptions(args);
  const squeeze = await compressor(compress, { ...options, config }, env);
  const out = openOut(option(args, '--out'), stdout);
  let next = 0, ok = 0, failed = 0;
  async function worker() {
    while (next < prompts.length) {
      const item = prompts[next++];
      const started = Date.now();
      let session;
      try {
        session = await agent.createSession({ root, config, env, permissionMode: options.permissionMode || null });
        session.headless = true;
        const turn = await agent.runAgentTurn(session, item.prompt, { env, approval: async () => false });
        ok++;
        out.write(JSON.stringify({ id: item.id, prompt: item.prompt, ok: true, text: clean(turn && turn.text || ''), toolCalls: turn && turn.toolCalls || 0, durationMs: Date.now() - started, ...(item.metadata ? { metadata: item.metadata } : {}), trajectory: await formatWith({ id: item.id, messages: session.messages, config }, format, session.toolDefinitions || [], squeeze) }) + '\n');
      } catch (error) {
        failed++;
        out.write(JSON.stringify({ id: item.id, prompt: item.prompt, ok: false, error: clean(String(error && error.message || error)), durationMs: Date.now() - started }) + '\n');
      } finally {
        if (session && typeof agent.closeSession === 'function') await Promise.resolve().then(() => agent.closeSession(session)).catch(() => {});
        stderr.write('[batch] ' + (ok + failed) + '/' + prompts.length + ' done (' + failed + ' failed)\n');
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, prompts.length) }, worker));
  await out.close();
  if (squeeze) await squeeze.finish();
  return { total: prompts.length, ok, failed };
}
