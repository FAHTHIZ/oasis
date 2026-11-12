// Real context windows for local model servers.
//
// Ollama's OpenAI-compatible endpoint ignores per-request context options and
// loads models with a server-wide default that is often 4,096 tokens on GPUs
// with less than 24 GB of VRAM. When a prompt is longer than the loaded window,
// Ollama silently drops the oldest tokens, which removes the system prompt and
// tool instructions first. OASIS would otherwise size compaction from the
// model's advertised window (for example 128K for qwen3) and never compact.
//
// This module asks Ollama what it actually loaded (/api/ps, then the Modelfile
// num_ctx from /api/show), so the session can compact at the real limit, send a
// smaller tool set, and tell the user exactly how to raise the window.

const PROBE_TIMEOUT_MS = 2000;

// Agent prompts need room for instructions, tool schemas, file contents and the
// reply. Below this the session switches to the small-context tool profile.
export const SMALL_CONTEXT_TOKENS = 16_384;
// Below this, coding-agent work is unreliable even with the small profile.
export const RECOMMENDED_LOCAL_CONTEXT = 32_768;

// Tools that cover read, search, edit, run and verify. Everything else stays
// one tool_search away.
export const SMALL_CONTEXT_TOOLS = Object.freeze([
  'read_file', 'list_files', 'glob_files', 'grep', 'edit_file', 'write_file',
  'run_command', 'command_output', 'git_status', 'git_diff', 'todo_write', 'tool_search'
]);

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'host.docker.internal']);

export function isOllamaEndpoint(config = {}, env = process.env) {
  if (/^(?:1|true|yes|on)$/i.test(String(env.OASIS_OLLAMA || ''))) return true;
  if (String(config.protocol || 'openai-compatible').toLowerCase() !== 'openai-compatible') return false;
  try {
    const url = new URL(String(config.baseURL || ''));
    return url.port === '11434' || /(^|\.)ollama(\.|$)/i.test(url.hostname);
  } catch { return false; }
}

// Default ports: LM Studio 1234, llama-server 8080.
const LOCAL_SERVER_PORTS = new Set(['1234', '8080']);

// Local OpenAI-compatible servers whose loaded window can be probed: Ollama,
// LM Studio and llama.cpp's llama-server. Other loopback ports are probed only
// with OASIS_LOCAL_CONTEXT_PROBE=1, so unrelated local services never receive
// unexpected requests.
export function isLocalModelEndpoint(config = {}, env = process.env) {
  if (isOllamaEndpoint(config, env)) return true;
  if (String(config.protocol || 'openai-compatible').toLowerCase() !== 'openai-compatible') return false;
  try {
    const url = new URL(String(config.baseURL || ''));
    if (!LOCAL_HOSTS.has(url.hostname.toLowerCase())) return false;
    return LOCAL_SERVER_PORTS.has(url.port) || /^(?:1|true|yes|on)$/i.test(String(env.OASIS_LOCAL_CONTEXT_PROBE || ''));
  } catch { return false; }
}

function ollamaOrigin(baseURL) {
  const url = new URL(String(baseURL));
  // The OpenAI-compatible API lives under /v1; the native API is at the root.
  const prefix = url.pathname.replace(/\/+$/, '').replace(/\/v1$/i, '');
  return url.origin + prefix;
}

const sameModel = (a, b) => {
  const norm = (value) => String(value || '').trim().toLowerCase().replace(/:latest$/, '');
  return norm(a) && norm(a) === norm(b);
};

async function getJson(fetchImpl, url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; } finally { clearTimeout(timer); }
}

// Returns { contextLength, source, loaded, nativeContext } or null when the
// server is unreachable or does not look like Ollama.
// Subagents and resumed sessions probe the same server repeatedly; a short
// cache keeps session start fast without hiding a restart with a new window.
const probeCache = new Map();
const PROBE_CACHE_MS = 30_000;

export async function probeOllamaContext(config = {}, { fetchImpl = globalThis.fetch, cache = true } = {}) {
  if (typeof fetchImpl !== 'function' || !config.model) return null;
  let origin;
  try { origin = ollamaOrigin(config.baseURL); } catch { return null; }
  const key = origin + '\n' + config.model;
  const cached = cache && probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.value;
  const value = await probeOllama(origin, config.model, fetchImpl);
  if (cache) probeCache.set(key, { at: Date.now(), value });
  return value;
}

async function probeOllama(origin, model, fetchImpl) {
  const config = { model };
  const [ps, show] = await Promise.all([
    getJson(fetchImpl, origin + '/api/ps'),
    getJson(fetchImpl, origin + '/api/show', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model })
    })
  ]);
  const running = ps && Array.isArray(ps.models) ? ps.models.find((item) => sameModel(item.name, config.model) || sameModel(item.model, config.model)) : null;
  let nativeContext = 0;
  let modelfileContext = 0;
  if (show) {
    for (const [key, value] of Object.entries(show.model_info || {})) {
      if (/\.context_length$/.test(key) && Number(value) > 0) nativeContext = Number(value);
    }
    const match = /(?:^|\n)\s*num_ctx\s+(\d+)/.exec(String(show.parameters || ''));
    if (match) modelfileContext = Number(match[1]);
  }
  if (running && Number(running.context_length) > 0) {
    return { contextLength: Number(running.context_length), source: 'loaded', loaded: true, nativeContext };
  }
  if (modelfileContext) return { contextLength: modelfileContext, source: 'modelfile', loaded: Boolean(running), nativeContext };
  if (!ps && !show) return null;
  return { contextLength: 0, source: 'unknown', loaded: Boolean(running), nativeContext };
}

// Ollama's OpenAI-compatible API cannot set the window per request, and a
// request reloads the model at the server default (often 4,096 tokens). A model
// created FROM the original with num_ctx set shares its weights (no download, no
// extra disk) and always loads with that window, so `oasis connect` makes one.
export function ollamaWideModelName(model) {
  const value = String(model || '').trim();
  if (!value) return '';
  const colon = value.lastIndexOf(':');
  const slash = value.lastIndexOf('/');
  const hasTag = colon > slash;
  return hasTag ? value + '-oasis' : value + ':latest-oasis';
}

export async function widenOllamaContext(config = {}, { fetchImpl = globalThis.fetch, target = RECOMMENDED_LOCAL_CONTEXT, onStatus = () => {} } = {}) {
  if (typeof fetchImpl !== 'function' || !config.model || !isOllamaEndpoint(config, {})) return null;
  if (/-oasis$/i.test(String(config.model))) return null;
  let origin;
  try { origin = ollamaOrigin(config.baseURL); } catch { return null; }
  const probe = await probeOllama(origin, config.model, fetchImpl);
  if (!probe) return null;
  // Already wide enough: a Modelfile num_ctx or a server started with a large OLLAMA_CONTEXT_LENGTH.
  if (probe.contextLength >= target) return null;
  const size = Math.min(target, probe.nativeContext || target);
  if (size < SMALL_CONTEXT_TOKENS || size <= probe.contextLength) return null;
  const wide = ollamaWideModelName(config.model);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetchImpl(origin + '/api/create', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: wide, from: config.model, parameters: { num_ctx: size }, stream: false }),
      signal: controller.signal
    });
    if (!response.ok) return null;
    const body = await response.json().catch(() => ({}));
    if (body && body.error) return null;
  } catch { return null; } finally { clearTimeout(timer); }
  probeCache.clear();
  const before = probe.contextLength ? probe.contextLength.toLocaleString('en-US') + '-token' : 'small default';
  onStatus({ step: 'context', text: 'Ollama loads ' + config.model + ' with a ' + before + ' window, too small for agent work. Created ' + wide + ': the same model and weights with a ' + size.toLocaleString('en-US') + '-token window.' });
  return { model: wide, contextLength: size, from: config.model };
}

export function localContextAdvice(model, contextLength, server = 'ollama') {
  const size = Number(contextLength).toLocaleString('en-US');
  const want = RECOMMENDED_LOCAL_CONTEXT;
  const fix = server === 'lmstudio'
    ? 'Reload it with a larger context length (lms load ' + model + ' --context-length ' + want + ', or the Context Length slider in LM Studio).'
    : server === 'llama.cpp'
      ? 'Restart llama-server with --ctx-size ' + want + ' (with --parallel N, each slot gets ctx-size / N).'
      : 'Run oasis connect http://localhost:11434 to let OASIS create a ' + want.toLocaleString('en-US') + '-token variant of the model (same weights, no download), or restart Ollama with OLLAMA_CONTEXT_LENGTH=' + want + '.';
  const name = server === 'lmstudio' ? 'LM Studio' : server === 'llama.cpp' ? 'llama-server' : 'Ollama';
  return name + ' is serving ' + model + ' with a ' + size + '-token context window, which is too small for reliable agent work (' +
    want.toLocaleString('en-US') + '+ recommended). ' + fix + ' OASIS will compact early and send a smaller tool set until then.';
}

// Keeps the essential tools in the request and defers the rest behind
// tool_search, so instructions and tool schemas fit a small window.
export function applySmallContextProfile(session, toolSearchDefinition) {
  const keep = new Set(SMALL_CONTEXT_TOOLS);
  const deferred = session.toolDefinitions.filter((tool) => !keep.has(tool.function.name));
  if (!deferred.length) return 0;
  if (!session.deferredTools) session.deferredTools = new Map();
  for (const tool of deferred) session.deferredTools.set(tool.function.name, tool);
  session.toolDefinitions = session.toolDefinitions.filter((tool) => keep.has(tool.function.name));
  if (toolSearchDefinition && !session.toolDefinitions.some((tool) => tool.function.name === 'tool_search')) session.toolDefinitions.push(toolSearchDefinition);
  return deferred.length;
}

// LM Studio: /api/v0/models reports loaded_context_length for loaded models;
// /api/v1/models lists loaded_instances[].config.context_length.
async function probeLmStudio(origin, model, fetchImpl) {
  const v0 = await getJson(fetchImpl, origin + '/api/v0/models');
  if (v0 && Array.isArray(v0.data)) {
    const row = v0.data.find((item) => sameModel(item.id, model));
    if (row && row.state === 'loaded' && Number(row.loaded_context_length) > 0) {
      return { contextLength: Number(row.loaded_context_length), source: 'loaded', loaded: true, nativeContext: Number(row.max_context_length) || 0, server: 'lmstudio' };
    }
    if (row) return { contextLength: 0, source: 'unknown', loaded: false, nativeContext: Number(row.max_context_length) || 0, server: 'lmstudio' };
  }
  const v1 = await getJson(fetchImpl, origin + '/api/v1/models');
  const rows = v1 && (Array.isArray(v1.models) ? v1.models : Array.isArray(v1.data) ? v1.data : null);
  if (rows) {
    const row = rows.find((item) => sameModel(item.key, model) || sameModel(item.id, model));
    const sizes = row && Array.isArray(row.loaded_instances) ? row.loaded_instances.map((instance) => Number(instance && instance.config && instance.config.context_length)).filter((n) => n > 0) : [];
    if (sizes.length) return { contextLength: Math.min(...sizes), source: 'loaded', loaded: true, nativeContext: Number(row.max_context_length) || 0, server: 'lmstudio' };
    if (row) return { contextLength: 0, source: 'unknown', loaded: false, nativeContext: Number(row.max_context_length) || 0, server: 'lmstudio' };
  }
  return null;
}

// llama.cpp llama-server: /props reports the per-slot n_ctx it serves.
async function probeLlamaCpp(origin, fetchImpl) {
  const props = await getJson(fetchImpl, origin + '/props');
  const settings = props && props.default_generation_settings;
  const nCtx = Number(settings && (settings.n_ctx ?? (settings.params && settings.params.n_ctx)));
  if (nCtx > 0) return { contextLength: nCtx, source: 'loaded', loaded: true, nativeContext: 0, server: 'llama.cpp' };
  return null;
}

// Probes whichever local server answers. Ollama endpoints only try Ollama.
export async function probeLocalContext(config = {}, { fetchImpl = globalThis.fetch, env = process.env, cache = true } = {}) {
  if (isOllamaEndpoint(config, env)) {
    const probe = await probeOllamaContext(config, { fetchImpl, cache });
    return probe && { ...probe, server: 'ollama' };
  }
  if (typeof fetchImpl !== 'function' || !config.model || !isLocalModelEndpoint(config, env)) return null;
  let origin;
  try { origin = ollamaOrigin(config.baseURL); } catch { return null; }
  const key = 'local\n' + origin + '\n' + config.model;
  const cached = cache && probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS) return cached.value;
  const [lmstudio, llamacpp, ollama] = await Promise.all([
    probeLmStudio(origin, config.model, fetchImpl),
    probeLlamaCpp(origin, fetchImpl),
    probeOllama(origin, config.model, fetchImpl).then((probe) => probe && probe.contextLength ? { ...probe, server: 'ollama' } : null)
  ]);
  const value = [lmstudio, llamacpp, ollama].find((probe) => probe && probe.contextLength) || lmstudio || null;
  if (cache) probeCache.set(key, { at: Date.now(), value });
  return value;
}

// Hosted and self-hosted OpenAI-compatible providers often publish each model's
// window on GET /models: DeepSeek `context_window`, OpenRouter `context_length`
// (or top_provider.context_length), vLLM `max_model_len`. Used only for models
// the built-in table does not know. Loopback servers are skipped unless
// OASIS_LOCAL_CONTEXT_PROBE=1, matching the local probe policy.
export function modelWindowFromListing(listing, model) {
  const rows = listing && Array.isArray(listing.data) ? listing.data : Array.isArray(listing) ? listing : [];
  const wanted = String(model || '').trim().toLowerCase();
  if (!wanted) return 0;
  const row = rows.find((item) => item && String(item.id || '').toLowerCase() === wanted) ||
    rows.find((item) => item && String(item.id || '').toLowerCase().split('/').pop() === wanted.split('/').pop());
  if (!row) return 0;
  const sizes = [row.context_window, row.context_length, row.max_model_len, row.max_context_length, row.top_provider && row.top_provider.context_length]
    .map(Number).filter((n) => Number.isFinite(n) && n >= 1024);
  return sizes.length ? sizes[0] : 0;
}

export async function probeProviderModelWindow(config = {}, { fetchImpl = globalThis.fetch, env = process.env, cache = true } = {}) {
  if (typeof fetchImpl !== 'function' || !config.model) return 0;
  if (String(config.protocol || 'openai-compatible').toLowerCase() !== 'openai-compatible') return 0;
  if (/^(?:0|false|off|no)$/i.test(String(env.OASIS_MODEL_INFO_PROBE || ''))) return 0;
  let url;
  try { url = new URL(String(config.baseURL || '')); } catch { return 0; }
  if (LOCAL_HOSTS.has(url.hostname.toLowerCase()) && !/^(?:1|true|yes|on)$/i.test(String(env.OASIS_LOCAL_CONTEXT_PROBE || ''))) return 0;
  const endpoint = url.origin + url.pathname.replace(/\/+$/, '') + '/models';
  const key = 'models\n' + endpoint + '\n' + config.model;
  const cached = cache && probeCache.get(key);
  if (cached && Date.now() - cached.at < PROBE_CACHE_MS * 20) return cached.value;
  const headers = { accept: 'application/json' };
  if (typeof config.apiKey === 'string' && config.apiKey) headers.authorization = 'Bearer ' + config.apiKey;
  const value = modelWindowFromListing(await getJson(fetchImpl, endpoint, { headers }), config.model);
  if (cache) probeCache.set(key, { at: Date.now(), value });
  return value;
}
