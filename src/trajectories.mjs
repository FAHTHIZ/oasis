// Trajectory export and batch runs, for evaluation and fine-tuning datasets.
//
//   oasis sessions export [ID...|--all] [--format sharegpt|openai] [--out FILE]
//   oasis batch PROMPTS.jsonl [--out FILE] [--format sharegpt|openai] [--concurrency N]
//
// Export writes one JSON object per line. "openai" keeps the chat-completions
// message list (system, user, assistant with tool_calls, tool) plus the tool
// schemas; "sharegpt" maps it to {from: system|human|gpt|function_call|observation, value}.
// Secrets are redacted with the same patterns as auto memory.
import { createWriteStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { redactSecrets } from './auto-memory.mjs';
import { redactAuditValue } from './tool-kernel.mjs';

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
    if (message.role === 'tool') item.tool_call_id = String(message.tool_call_id || '');
    messages.push(item);
  }
  return { id: data.id || null, model: data.model || (data.provider && data.provider.model) || (data.config && data.config.model) || null, messages, tools: tools.map((tool) => tool && tool.function ? { type: 'function', function: { name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters } } : tool).filter(Boolean), metadata: { source: 'oasis', updatedAt: data.updatedAt || null, workspace: data.workspaceRoot ? path.basename(data.workspaceRoot) : null } };
}

export function toShareGPTRecord(data, tools = []) {
  const record = toOpenAIRecord(data, tools);
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
  return { id: record.id, conversations, tools: JSON.stringify(record.tools.map((tool) => tool.function || tool)), metadata: record.metadata };
}

export function formatRecord(data, format = 'openai', tools = []) {
  if (format === 'sharegpt') return toShareGPTRecord(data, tools);
  if (format === 'openai') return toOpenAIRecord(data, tools);
  throw new Error('Unknown export format ' + format + '. Use sharegpt or openai.');
}

function option(args, name, fallback = null) {
  const at = args.indexOf(name);
  return at >= 0 && args[at + 1] && !args[at + 1].startsWith('--') ? args[at + 1] : fallback;
}

function openOut(file, stdout) {
  if (!file || file === '-') return { write: (line) => stdout.write(line), close: async () => {} };
  const stream = createWriteStream(file, { flags: 'w', mode: 0o600 });
  return { write: (line) => stream.write(line), close: () => new Promise((resolve, reject) => stream.end((error) => error ? reject(error) : resolve())) };
}

export async function exportSessions(root, args = [], options = {}) {
  const env = options.env || process.env;
  const stdout = options.stdout || process.stdout;
  const format = option(args, '--format', 'openai');
  formatRecord({ messages: [] }, format);
  const { listSessions, loadSession } = await import('./sessions.mjs');
  const flagValues = new Set([option(args, '--format'), option(args, '--out')].filter(Boolean));
  let ids = args.filter((arg) => !arg.startsWith('--') && !flagValues.has(arg));
  if (args.includes('--all') || !ids.length) {
    if (!args.includes('--all')) throw new Error('Usage: oasis sessions export SESSION_ID... | --all [--format sharegpt|openai] [--out FILE]');
    ids = (await listSessions(root, { env })).map((item) => item.id);
  }
  const out = openOut(option(args, '--out'), stdout);
  let count = 0;
  for (const id of ids) {
    const data = await loadSession(root, id, { env });
    out.write(JSON.stringify(formatRecord({ ...data, id: data.id || id }, format)) + '\n');
    count++;
  }
  await out.close();
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
  const file = args.find((arg) => !arg.startsWith('--') && arg !== option(args, '--out') && arg !== option(args, '--format') && arg !== option(args, '--concurrency'));
  if (!file) throw new Error('Usage: oasis batch PROMPTS.jsonl [--out FILE] [--format sharegpt|openai] [--concurrency N]');
  const format = option(args, '--format', 'openai');
  formatRecord({ messages: [] }, format);
  const concurrency = Math.min(8, Math.max(1, Number.parseInt(option(args, '--concurrency', '1'), 10) || 1));
  const prompts = await parsePromptFile(path.resolve(root, file));
  const agent = options.agent || await import('./agent.mjs');
  const { loadConfig } = options.configModule || await import('./config.mjs');
  const config = options.config || await loadConfig({ env });
  if (!config.configured) throw new Error('No model provider is configured. Run `oasis setup` first.');
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
        out.write(JSON.stringify({ id: item.id, prompt: item.prompt, ok: true, text: clean(turn && turn.text || ''), toolCalls: turn && turn.toolCalls || 0, durationMs: Date.now() - started, ...(item.metadata ? { metadata: item.metadata } : {}), trajectory: formatRecord({ id: item.id, messages: session.messages, config }, format, session.toolDefinitions || []) }) + '\n');
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
  return { total: prompts.length, ok, failed };
}
