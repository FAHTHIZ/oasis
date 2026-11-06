// Model providers for the universal app. Everything runs on the device: the
// app talks straight to the provider's HTTPS API with the user's own key.
// Internal messages use the Chat Completions shape; the Anthropic adapter
// converts to and from Messages API blocks.

export const PRESETS = {
  openrouter: { label: 'OpenRouter', protocol: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder', keyHint: 'sk-or-…', note: 'One key for hundreds of models, including free ones.' },
  anthropic: { label: 'Anthropic', protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-5', keyHint: 'sk-ant-…' },
  openai: { label: 'OpenAI', protocol: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', keyHint: 'sk-…' },
  gemini: { label: 'Google Gemini', protocol: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', keyHint: 'AQ.… or AIza…' },
  groq: { label: 'Groq', protocol: 'openai', baseURL: 'https://api.groq.com/openai/v1', model: 'moonshotai/kimi-k2-instruct', keyHint: 'gsk_…' },
  deepseek: { label: 'DeepSeek', protocol: 'openai', baseURL: 'https://api.deepseek.com/v1', model: 'deepseek-chat', keyHint: 'sk-…' },
  mistral: { label: 'Mistral', protocol: 'openai', baseURL: 'https://api.mistral.ai/v1', model: 'devstral-medium-latest', keyHint: '' },
  xai: { label: 'xAI', protocol: 'openai', baseURL: 'https://api.x.ai/v1', model: 'grok-code-fast-1', keyHint: 'xai-…' },
  huggingface: { label: 'Hugging Face', protocol: 'openai', baseURL: 'https://router.huggingface.co/v1', model: 'Qwen/Qwen3-Coder-480B-A35B-Instruct', keyHint: 'hf_…', note: 'Any chat model served by Hugging Face Inference Providers.' },
  together: { label: 'Together AI', protocol: 'openai', baseURL: 'https://api.together.xyz/v1', model: '', keyHint: '' },
  fireworks: { label: 'Fireworks AI', protocol: 'openai', baseURL: 'https://api.fireworks.ai/inference/v1', model: '', keyHint: 'fw_…' },
  cerebras: { label: 'Cerebras', protocol: 'openai', baseURL: 'https://api.cerebras.ai/v1', model: '', keyHint: 'csk-…' },
  nvidia: { label: 'NVIDIA NIM', protocol: 'openai', baseURL: 'https://integrate.api.nvidia.com/v1', model: '', keyHint: 'nvapi-…' },
  moonshot: { label: 'Moonshot (Kimi)', protocol: 'openai', baseURL: 'https://api.moonshot.ai/v1', model: '', keyHint: 'sk-…' },
  ollama: { label: 'Ollama (your computer)', protocol: 'openai', baseURL: 'http://localhost:11434/v1', model: 'qwen3-coder:30b', keyHint: 'not needed', note: 'Start Ollama with OLLAMA_ORIGINS=* so the app may reach it.' },
  lmstudio: { label: 'LM Studio (your computer)', protocol: 'openai', baseURL: 'http://localhost:1234/v1', model: '', keyHint: 'not needed', note: 'Turn on the local server and CORS in LM Studio.' },
  llamacpp: { label: 'llama.cpp server', protocol: 'openai', baseURL: 'http://localhost:8080/v1', model: '', keyHint: 'not needed' },
  custom: { label: 'Custom (OpenAI-compatible)', protocol: 'openai', baseURL: '', model: '', keyHint: '' }
};

import { createParser } from 'eventsource-parser';
import { splitThinking, createThinkFilter } from './think-tags.mjs';

export class ProviderError extends Error {
  constructor(message, { status = 0, retryable = false, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
    this.retryAfterMs = retryAfterMs;
  }
}

/**
 * Whether a failed request is worth retrying, and when. A daily or billing
 * quota will not clear in seconds, so it fails at once (and the agent can
 * fall back). Gemini words per-minute limits like exhausted quota; its
 * quota id and RetryInfo say how long to wait.
 */
export function retryPlan(status, body = '') {
  const text = String(body || '');
  if (status === 429) {
    const perMinute = /PerMinute|per ?minute/i.test(text) && !/PerDay|per ?day/i.test(text);
    if (perMinute) {
      const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text) || /retry in (\d+(?:\.\d+)?)s\b/i.exec(text);
      const ms = delay ? Number(delay[1]) * 1000 : 20000;
      return ms <= 90000 ? { retryable: true, retryAfterMs: Math.ceil(ms) + 500 } : { retryable: false };
    }
    if (/insufficient_quota|exceeded your current quota|billing|PerDay|per ?day|limit: ?0\b/i.test(text)) return { retryable: false };
    return { retryable: true };
  }
  // gpt-oss behind some gateways: the server could not parse the model's own
  // harmony output ("Unknown role: assistant<|channel|>commentary"); the
  // request itself was fine, so a retry usually works.
  if (status === 400 && /<\|(?:channel|message|start|end|call|constrain|return)\|>/.test(text)) return { retryable: true };
  return { retryable: status >= 500 };
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function isOpenRouterEndpoint(baseURL) {
  try {
    const host = new URL(String(baseURL || '')).hostname.toLowerCase();
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch { return false; }
}

function openRouterCreditInfo(status, body, config) {
  if (status !== 402 || !isOpenRouterEndpoint(config && config.baseURL)) return null;
  let parsed;
  try { parsed = JSON.parse(String(body || '').slice(0, 16000)); } catch { return null; }
  const error = parsed && parsed.error;
  if (!error || !error.metadata || error.metadata.limit_source !== 'openrouter_credits') return null;
  const message = String(error.message || '');
  const availableMatch = message.match(/can only afford\s+([\d,]+)/i);
  const requestedMatch = message.match(/requested up to\s+([\d,]+)/i);
  const available = availableMatch ? Number(availableMatch[1].replace(/,/g, '')) : 0;
  if (!Number.isSafeInteger(available) || available <= 0) return null;
  return { available, requested: requestedMatch ? Number(requestedMatch[1].replace(/,/g, '')) : 0 };
}

function openRouterCreditRetryCap(info) {
  if (!info || info.available < 80) return 0;
  return Math.floor((info.available * 0.8) / 64) * 64;
}

function explain(status, body, config) {
  const text = String(body || '').slice(0, 16000);
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  // Google wraps errors in an array: [{ error: {...} }].
  if (Array.isArray(parsed)) parsed = parsed.find((item) => item && typeof item === 'object') || null;
  let detail = parsed
    ? (parsed.error && (parsed.error.message || parsed.error)) || parsed.message || text
    : text.slice(0, 600);
  if (typeof detail !== 'string') detail = JSON.stringify(detail);
  const creditInfo = openRouterCreditInfo(status, text, config);
  if (creditInfo) {
    const requested = creditInfo.requested ? ' The request reserved up to ' + creditInfo.requested.toLocaleString() + ' output tokens.' : '';
    return 'OpenRouter does not have enough remaining credits for this request. Its response says the current balance can cover about ' +
      creditInfo.available.toLocaleString() + ' output tokens.' + requested +
      ' This is a credit limit, not an invalid API key. Try a free model or a smaller output limit. See https://openrouter.ai/settings/credits.';
  }
  if (status === 401 || status === 403) return 'The provider rejected the API key (' + status + '). Check the key in Settings. ' + detail;
  if (status === 404) return 'The provider does not know model "' + config.model + '" or the base URL is wrong (404). ' + detail;
  if (status === 429) return 'The provider is rate limiting this key (429). Wait a moment or switch model. ' + detail;
  if (status === 402) return 'The provider requires available credits or quota (402). This is not an API-key authentication error. ' + detail;
  return 'The provider returned ' + status + '. ' + detail;
}

/** A JSON error body ({ error } or [{ error }]) that arrived outside SSE events. */
export function malformedCallFinish(reason) {
  return /MALFORMED_FUNCTION_CALL/i.test(String(reason || ''));
}

export function strayStreamError(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch {
    if (!/"error"/.test(raw)) return null;
    const match = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
    return { message: match ? match[1] : 'the provider sent an error', status: Number((/"code"\s*:\s*(\d{3})/.exec(raw) || [])[1]) || 0 };
  }
  const body = Array.isArray(parsed) ? parsed[0] : parsed;
  const error = body && typeof body === 'object' ? body.error : null;
  if (!error) return null;
  return { message: String(typeof error === 'string' ? error : error.message || error.status || 'the provider sent an error').slice(0, 400), status: Number(error.code) || 0 };
}

// Server-sent events are parsed by eventsource-parser (WHATWG EventSource
// rules: CR, LF or CRLF line ends, multi-line data, comments, id/retry).
// Lines that are not SSE at all (a bare JSON error body, an HTML error page)
// come back as 'stray' events so the caller can report them.
async function* sseEvents(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queue = [];
  const parser = createParser({
    onEvent: (message) => queue.push({ event: message.event || 'message', data: message.data }),
    onError: (error) => { if (error.type === 'unknown-field' && error.line && error.line.trim()) queue.push({ event: 'stray', data: error.line }); }
  });
  try {
    while (true) {
      if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
      while (queue.length) yield queue.shift();
    }
    // A final event without its blank line is still delivered, as before.
    parser.feed(decoder.decode() + '\n\n');
    while (queue.length) yield queue.shift();
  } finally {
    try { reader.releaseLock(); } catch {}
  }
}

function openAIHeaders(config) {
  const headers = { 'content-type': 'application/json' };
  if (config.apiKey) headers.authorization = 'Bearer ' + config.apiKey;
  if (/openrouter\.ai/.test(config.baseURL)) {
    headers['HTTP-Referer'] = config.referer || 'https://fahthiz.github.io/oasis/';
    headers['X-Title'] = 'OASIS';
  }
  return headers;
}

const openRouterOutputCaps = new Map();

function openRouterCapKey(config) {
  return [config.connectionId || config.provider || '', trimSlash(config.baseURL), config.model || ''].join('|');
}

// Gemini 3 returns extra_content.google.thought_signature on tool calls and
// rejects the next turn unless it comes back. Keep it for Gemini (direct or
// through a gateway) and strip it for every other model.
function geminiTarget(config) {
  let host = '';
  try { host = new URL(String(config.baseURL || '')).hostname.toLowerCase(); } catch {}
  return host === 'generativelanguage.googleapis.com' || /gemini/i.test(String(config.model || ''));
}

function withExtraContentFor(config, messages) {
  if (geminiTarget(config) || !messages.some((m) => Array.isArray(m && m.tool_calls) && m.tool_calls.some((c) => c && c.extra_content))) return messages;
  return messages.map((m) => Array.isArray(m && m.tool_calls)
    ? { ...m, tool_calls: m.tool_calls.map((c) => { if (!c || !c.extra_content) return c; const { extra_content: _drop, ...rest } = c; return rest; }) }
    : m);
}

// Strict servers (Gemini) reject unknown keys under tools[].function.
function cleanTool(tool) {
  if (!tool || !tool.function) return tool;
  const fn = {};
  for (const key of ['name', 'description', 'parameters', 'strict']) if (tool.function[key] !== undefined) fn[key] = tool.function[key];
  return { type: 'function', function: fn };
}

async function chatOpenAI(config, { messages, tools, signal, onText: rawOnText, fetchImpl }) {
  // Leading <think>/<thought> blocks are reasoning, not the reply.
  const thinkFilter = rawOnText ? createThinkFilter(rawOnText) : null;
  const onText = thinkFilter ? (chunk) => thinkFilter.push(chunk) : null;
  const body = { model: config.model, messages: withExtraContentFor(config, messages), stream: true };
  if (tools && tools.length) body.tools = tools.map(cleanTool);
  const openRouter = isOpenRouterEndpoint(config.baseURL);
  const learnedLimit = openRouter ? openRouterOutputCaps.get(openRouterCapKey(config)) : 0;
  const requestedLimit = learnedLimit
    ? Math.min(Number(config.maxTokens) || learnedLimit, learnedLimit)
    : (Number(config.maxTokens) || (openRouter ? 4096 : 0));
  if (requestedLimit > 0) body.max_tokens = requestedLimit;
  if (config.temperature !== undefined && config.temperature !== '') body.temperature = Number(config.temperature);
  if (!/localhost|127\.0\.0\.1/.test(config.baseURL)) body.stream_options = { include_usage: true };
  const url = trimSlash(config.baseURL) + '/chat/completions';
  const headers = openAIHeaders(config);
  let response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    const creditInfo = openRouterCreditInfo(response.status, errorBody, config);
    const retryLimit = openRouterCreditRetryCap(creditInfo);
    if (retryLimit >= 64 && retryLimit < (Number(body.max_tokens) || 65536)) {
      // OpenRouter reserves against max_tokens, not only the tokens eventually emitted.
      // Retry once using the affordable range reported by its explicit credit-limit error.
      body.max_tokens = retryLimit;
      openRouterOutputCaps.set(openRouterCapKey(config), retryLimit);
      response = await fetchImpl(url, { method: 'POST', headers, body: JSON.stringify(body), signal });
      if (!response.ok) {
        const retryBody = await response.text().catch(() => '');
        throw new ProviderError(explain(response.status, retryBody, config), { status: response.status, ...retryPlan(response.status, retryBody) });
      }
    } else {
      throw new ProviderError(explain(response.status, errorBody, config), { status: response.status, ...retryPlan(response.status, errorBody) });
    }
  }
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new ProviderError(explain(response.status, errorBody, config), { status: response.status, ...retryPlan(response.status, errorBody) });
  }
  const type = response.headers.get('content-type') || '';
  if (!type.includes('event-stream')) {
    const data = await response.json();
    const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const plain = splitThinking(message.content || '').content;
    if (malformedCallFinish(data.choices && data.choices[0] && data.choices[0].finish_reason) && !plain.trim() && !(message.tool_calls || []).length) throw new ProviderError('The model produced a malformed tool call; asking again.', { retryable: true });
    if (plain && rawOnText) rawOnText(plain);
    return { content: plain, tool_calls: message.tool_calls || [], usage: normalizeUsage(data.usage) };
  }
  let content = '';
  const calls = [];
  let usage = null;
  let finished = false;
  let finishReason = '';
  let stray = '';
  for await (const { event, data } of sseEvents(response, signal)) {
    if (event === 'stray') { if (stray.length < 16384) stray += data + '\n'; continue; }
    if (data === '[DONE]') break;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    if (chunk.error) throw new ProviderError('The provider reported an error mid-stream: ' + (chunk.error.message || JSON.stringify(chunk.error)), { retryable: true });
    if (chunk.usage) usage = normalizeUsage(chunk.usage);
    if (chunk.choices && chunk.choices[0] && chunk.choices[0].finish_reason) { finished = true; finishReason = String(chunk.choices[0].finish_reason); }
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (!delta) continue;
    if (delta.content) { content += delta.content; if (onText) onText(delta.content); }
    for (const part of delta.tool_calls || []) {
      // Gemini sends each parallel call whole, with its own id and no index;
      // OpenAI sends index. A new id is a new call (some gateways number all 0).
      let index = part.id ? calls.findIndex((c) => c && c.id === part.id) : -1;
      if (index < 0) {
        const given = part.index !== undefined && part.index !== null ? Number(part.index) : null;
        const existing = given !== null ? calls[given] : null;
        // A new index with no id and no name continues the previous call (a
        // gateway sent call 0's closing "}" as index 1).
        if (given !== null && !existing && !part.id && !(part.function && part.function.name) && calls.length) index = calls.length - 1;
        else if (given !== null && !(part.id && existing && existing.id && existing.id !== part.id && existing.function.name)) index = given;
        else index = part.id || !calls.length ? calls.length : calls.length - 1;
      }
      const call = calls[index] || (calls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (part.id) call.id = part.id;
      if (part.function && part.function.name) call.function.name += part.function.name;
      if (part.function && part.function.arguments) call.function.arguments += part.function.arguments;
      if (part.extra_content && typeof part.extra_content === 'object') call.extra_content = { ...(call.extra_content || {}), ...part.extra_content };
    }
  }
  // Gemini can end a stream with a bare JSON 503 body after some text; that
  // reply is broken, so retry it instead of keeping the fragment.
  const broken = finished ? null : strayStreamError(stray);
  if (broken) throw new ProviderError('The provider reported an error mid-stream: ' + broken.message, { status: broken.status, retryable: true });
  // Gemini ends with "function_call_filter: MALFORMED_FUNCTION_CALL" and no
  // output when its own tool call failed to parse; that is not an answer.
  if (malformedCallFinish(finishReason) && !content.trim() && !calls.filter(Boolean).length) throw new ProviderError('The model produced a malformed tool call; asking again.', { retryable: true });
  if (thinkFilter) thinkFilter.flush();
  const toolCalls = calls.filter(Boolean).map((call, i) => ({ ...call, id: call.id || 'call_' + Date.now().toString(36) + i }));
  return { content: splitThinking(content).content, tool_calls: toolCalls, usage };
}

function normalizeUsage(usage) {
  if (!usage) return null;
  return {
    input: Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) + Number(usage.cache_read_input_tokens || 0) + Number(usage.cache_creation_input_tokens || 0),
    output: Number(usage.completion_tokens ?? usage.output_tokens ?? 0)
  };
}

/** Chat Completions messages to Anthropic Messages API system + messages. */
export function toAnthropic(messages) {
  const system = [];
  const out = [];
  const push = (role, block) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const message of messages) {
    if (message.role === 'system') { system.push(String(message.content || '')); continue; }
    if (message.role === 'tool') { push('user', { type: 'tool_result', tool_use_id: message.tool_call_id, content: String(message.content ?? '') }); continue; }
    if (message.role === 'assistant') {
      if (message.content) push('assistant', { type: 'text', text: String(message.content) });
      for (const call of message.tool_calls || []) {
        let input = {};
        try { input = JSON.parse(call.function.arguments || '{}'); } catch {}
        push('assistant', { type: 'tool_use', id: call.id, name: call.function.name, input });
      }
      continue;
    }
    if (Array.isArray(message.content)) {
      // Text and pasted images (OpenAI-style parts) become Anthropic blocks.
      for (const part of message.content) {
        const match = part && part.type === 'image_url' && /^data:(image\/[\w.+-]+);base64,(.+)$/.exec(String(part.image_url && part.image_url.url || ''));
        if (match) push('user', { type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
        else if (part && part.type === 'text') push('user', { type: 'text', text: String(part.text ?? '') });
      }
      continue;
    }
    push('user', { type: 'text', text: String(message.content ?? '') });
  }
  return { system: system.join('\n\n'), messages: out };
}

async function chatAnthropic(config, { messages, tools, signal, onText, fetchImpl }) {
  const { system, messages: converted } = toAnthropic(messages);
  const body = {
    model: config.model,
    max_tokens: Number(config.maxTokens) || 8192,
    system,
    messages: converted,
    stream: true,
    tools: (tools || []).map((tool) => ({ name: tool.function.name, description: tool.function.description, input_schema: tool.function.parameters }))
  };
  if (!body.tools.length) delete body.tools;
  const response = await fetchImpl(trimSlash(config.baseURL || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': config.apiKey || '', 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
    body: JSON.stringify(body),
    signal
  });
  if (!response.ok) {
    const errorBody = await response.text().catch(() => '');
    throw new ProviderError(explain(response.status, errorBody, config), { status: response.status, ...retryPlan(response.status, errorBody) });
  }
  let content = '';
  const blocks = [];
  const usage = { input: 0, output: 0 };
  for await (const { data } of sseEvents(response, signal)) {
    let event;
    try { event = JSON.parse(data); } catch { continue; }
    if (event.type === 'error') throw new ProviderError('The provider reported an error mid-stream: ' + ((event.error && event.error.message) || data), { retryable: true });
    if (event.type === 'message_start' && event.message && event.message.usage) {
      const u = event.message.usage;
      usage.input = Number(u.input_tokens || 0) + Number(u.cache_read_input_tokens || 0) + Number(u.cache_creation_input_tokens || 0);
    }
    if (event.type === 'content_block_start') blocks[event.index] = event.content_block.type === 'tool_use' ? { id: event.content_block.id, name: event.content_block.name, json: '' } : null;
    if (event.type === 'content_block_delta') {
      if (event.delta.type === 'text_delta') { content += event.delta.text; if (onText) onText(event.delta.text); }
      if (event.delta.type === 'input_json_delta' && blocks[event.index]) blocks[event.index].json += event.delta.partial_json;
    }
    if (event.type === 'message_delta' && event.usage) usage.output = Number(event.usage.output_tokens || 0);
  }
  const tool_calls = blocks.filter(Boolean).map((block) => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.json || '{}' } }));
  return { content, tool_calls, usage };
}

/**
 * One model call with retries on rate limits and server errors.
 * Returns { content, tool_calls, usage }.
 */
export async function chat(config, request) {
  const fetchImpl = request.fetchImpl || globalThis.fetch.bind(globalThis);
  if (!config || !config.model) throw new ProviderError('Choose a model in Settings first.');
  if (!config.baseURL && config.protocol !== 'anthropic') throw new ProviderError('Set the provider base URL in Settings.');
  const run = config.protocol === 'anthropic' ? chatAnthropic : chatOpenAI;
  let attempt = 0;
  while (true) {
    try {
      return await run(config, { ...request, fetchImpl });
    } catch (error) {
      if (error && error.name === 'AbortError') throw error;
      const network = error instanceof TypeError;
      const retryable = network || (error instanceof ProviderError && error.retryable);
      if (!retryable || attempt >= (Number.isInteger(config.maxRetries) ? config.maxRetries : 3)) {
        if (network) throw new ProviderError('Could not reach ' + (config.baseURL || 'the provider') + '. Check the connection, or the provider may not allow calls from a browser app (CORS). ' + error.message);
        throw error;
      }
      attempt += 1;
      if (request.onRetry) request.onRetry(attempt, error);
      const wait = error && Number.isFinite(error.retryAfterMs) ? error.retryAfterMs : 800 * 2 ** attempt;
      if (error && Number.isFinite(error.retryAfterMs)) attempt = Math.max(attempt, Number.isInteger(config.maxRetries) ? config.maxRetries : 3);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, wait);
        if (request.signal) request.signal.addEventListener('abort', () => { clearTimeout(timer); reject(Object.assign(new Error('Cancelled'), { name: 'AbortError' })); }, { once: true });
      });
    }
  }
}

/** A tiny inert tool-call probe to check a provider before saving it. */
/**
 * One short line for a failed request, e.g. "daily free-tier quota used up
 * (retry in 21h11m)" or "model retired by the provider". Shared by the CLI
 * and the app so both explain quota and retirement the same way.
 */
export function briefFailure(message, status = 0) {
  let text = String(message || '').replace(/\s+/g, ' ').trim();
  text = text.replace(/^Model provider returned HTTP \d+:\s*/i, '').replace(/\.?\s*Check the configured [^.]*\.?$/i, '');
  const retry = /retry in (?:(\d+)h)?(?:(\d+)m)?(?:([\d.]+)s)?/i.exec(text);
  const parts = retry ? [retry[1] && retry[1] + 'h', retry[2] && retry[2] + 'm', !retry[1] && retry[3] && Math.ceil(Number(retry[3])) + 's'].filter(Boolean) : [];
  const when = parts.length ? ' (retry in ' + parts.join('') + ')' : '';
  const freeTier = /free.?tier/i.test(text) ? 'free-tier ' : '';
  if (/per ?day|PerDay/i.test(text) && /quota|limit/i.test(text)) return 'daily ' + freeTier + 'quota used up' + when;
  if (/per ?minute|PerMinute/i.test(text) && /quota|limit/i.test(text)) return 'per-minute rate limit' + when;
  if (/limit: ?0\b/i.test(text) && /quota/i.test(text)) return 'this key has no ' + freeTier + 'quota for this model';
  if (/no longer available|deprecated|decommissioned|retired/i.test(text)) return 'model retired by the provider';
  if (/high demand|overloaded|temporarily unavailable/i.test(text)) return 'busy right now' + when;
  const code = Number(status) || 0;
  return (code && !/\(\d{3}\)/.test(text) ? 'HTTP ' + code + ': ' : '') + text.split(/(?<=[.!?])\s/)[0].slice(0, 140);
}

// `timeoutMs` bounds the whole probe: a busy model can hold a request open for
// minutes, and setup should move on to the next model instead of waiting.
export async function testProvider(config, fetchImpl, { timeoutMs = 0 } = {}) {
  const tools = [{ type: 'function', function: { name: 'record_ok', description: 'Record that the connection works.', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } }];
  const controller = timeoutMs > 0 && typeof AbortController === 'function' ? new AbortController() : null;
  let timedOut = false;
  const timer = controller ? setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs) : null;
  let result;
  try {
    result = await chat(config, { messages: [{ role: 'system', content: 'Call record_ok with ok=true. Do not write anything else.' }, { role: 'user', content: 'Check the connection.' }], tools, fetchImpl, ...(controller ? { signal: controller.signal } : {}) });
  } catch (error) {
    if (timedOut) throw Object.assign(new ProviderError(config.model + ' did not answer within ' + Math.round(timeoutMs / 1000) + ' seconds (the model may be busy).', { status: 504 }), { timedOut: true });
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
  const called = result.tool_calls.some((call) => call.function.name === 'record_ok');
  return { ok: true, toolCalling: called, reply: result.content.slice(0, 200) };
}
