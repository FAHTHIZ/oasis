// Model providers for the universal app. Everything runs on the device: the
// app talks straight to the provider's HTTPS API with the user's own key.
// Internal messages use the Chat Completions shape; the Anthropic adapter
// converts to and from Messages API blocks.

export const PRESETS = {
  openrouter: { label: 'OpenRouter', protocol: 'openai', baseURL: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder', keyHint: 'sk-or-…', note: 'One key for hundreds of models, including free ones.' },
  anthropic: { label: 'Anthropic', protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-5', keyHint: 'sk-ant-…' },
  openai: { label: 'OpenAI', protocol: 'openai', baseURL: 'https://api.openai.com/v1', model: 'gpt-6.1-sol', keyHint: 'sk-…' },
  gemini: { label: 'Google Gemini', protocol: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-3.8-flash', keyHint: 'AIza…' },
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

export class ProviderError extends Error {
  constructor(message, { status = 0, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.retryable = retryable;
  }
}

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

function explain(status, body, config) {
  const text = String(body || '').slice(0, 600);
  let detail = text;
  try {
    const parsed = JSON.parse(text);
    detail = (parsed.error && (parsed.error.message || parsed.error)) || parsed.message || text;
    if (typeof detail !== 'string') detail = JSON.stringify(detail);
  } catch {}
  if (status === 401 || status === 403) return 'The provider rejected the API key (' + status + '). Check the key in Settings. ' + detail;
  if (status === 404) return 'The provider does not know model "' + config.model + '" or the base URL is wrong (404). ' + detail;
  if (status === 429) return 'The provider is rate limiting this key (429). Wait a moment or switch model. ' + detail;
  return 'The provider returned ' + status + '. ' + detail;
}

async function* sseEvents(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      if (signal && signal.aborted) throw new DOMException('Stopped', 'AbortError');
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index;
      while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const raw = buffer.slice(0, index);
        buffer = buffer.slice(index).replace(/^\r?\n\r?\n/, '');
        let event = 'message';
        const data = [];
        for (const line of raw.split(/\r?\n/)) {
          if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (data.length) yield { event, data: data.join('\n') };
      }
    }
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

async function chatOpenAI(config, { messages, tools, signal, onText, fetchImpl }) {
  const body = { model: config.model, messages, stream: true };
  if (tools && tools.length) body.tools = tools;
  if (config.maxTokens) body.max_tokens = config.maxTokens;
  if (config.temperature !== undefined && config.temperature !== '') body.temperature = Number(config.temperature);
  if (!/localhost|127\.0\.0\.1/.test(config.baseURL)) body.stream_options = { include_usage: true };
  const response = await fetchImpl(trimSlash(config.baseURL) + '/chat/completions', { method: 'POST', headers: openAIHeaders(config), body: JSON.stringify(body), signal });
  if (!response.ok) throw new ProviderError(explain(response.status, await response.text().catch(() => ''), config), { status: response.status, retryable: response.status === 429 || response.status >= 500 });
  const type = response.headers.get('content-type') || '';
  if (!type.includes('event-stream')) {
    const data = await response.json();
    const message = (data.choices && data.choices[0] && data.choices[0].message) || {};
    if (message.content && onText) onText(message.content);
    return { content: message.content || '', tool_calls: message.tool_calls || [], usage: normalizeUsage(data.usage) };
  }
  let content = '';
  const calls = [];
  let usage = null;
  for await (const { data } of sseEvents(response, signal)) {
    if (data === '[DONE]') break;
    let chunk;
    try { chunk = JSON.parse(data); } catch { continue; }
    if (chunk.error) throw new ProviderError('The provider reported an error mid-stream: ' + (chunk.error.message || JSON.stringify(chunk.error)), { retryable: true });
    if (chunk.usage) usage = normalizeUsage(chunk.usage);
    const delta = chunk.choices && chunk.choices[0] && chunk.choices[0].delta;
    if (!delta) continue;
    if (delta.content) { content += delta.content; if (onText) onText(delta.content); }
    for (const part of delta.tool_calls || []) {
      const index = part.index ?? calls.length;
      const call = calls[index] || (calls[index] = { id: '', type: 'function', function: { name: '', arguments: '' } });
      if (part.id) call.id = part.id;
      if (part.function && part.function.name) call.function.name += part.function.name;
      if (part.function && part.function.arguments) call.function.arguments += part.function.arguments;
    }
  }
  const toolCalls = calls.filter(Boolean).map((call, i) => ({ ...call, id: call.id || 'call_' + Date.now().toString(36) + i }));
  return { content, tool_calls: toolCalls, usage };
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
  if (!response.ok) throw new ProviderError(explain(response.status, await response.text().catch(() => ''), config), { status: response.status, retryable: response.status === 429 || response.status >= 500 || response.status === 529 });
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
      await new Promise((resolve) => setTimeout(resolve, 800 * 2 ** attempt));
    }
  }
}

/** A tiny inert tool-call probe to check a provider before saving it. */
export async function testProvider(config, fetchImpl) {
  const tools = [{ type: 'function', function: { name: 'record_ok', description: 'Record that the connection works.', parameters: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] } } }];
  const result = await chat(config, { messages: [{ role: 'system', content: 'Call record_ok with ok=true. Do not write anything else.' }, { role: 'user', content: 'Check the connection.' }], tools, fetchImpl });
  const called = result.tool_calls.some((call) => call.function.name === 'record_ok');
  return { ok: true, toolCalling: called, reply: result.content.slice(0, 200) };
}
