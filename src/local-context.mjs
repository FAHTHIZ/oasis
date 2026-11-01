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
  'read_file', 'list_files', 'glob_files', 'search_files', 'grep', 'edit_file', 'write_file',
  'run_command', 'command_output', 'git_status', 'git_diff', 'todo_write', 'tool_search'
]);

export function isOllamaEndpoint(config = {}, env = process.env) {
  if (/^(?:1|true|yes|on)$/i.test(String(env.OASIS_OLLAMA || ''))) return true;
  if (String(config.protocol || 'openai-compatible').toLowerCase() !== 'openai-compatible') return false;
  try {
    const url = new URL(String(config.baseURL || ''));
    return url.port === '11434' || /(^|\.)ollama(\.|$)/i.test(url.hostname);
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
  const value = await probeUncached(origin, config.model, fetchImpl);
  if (cache) probeCache.set(key, { at: Date.now(), value });
  return value;
}

async function probeUncached(origin, model, fetchImpl) {
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

export function localContextAdvice(model, contextLength) {
  const size = Number(contextLength).toLocaleString('en-US');
  return 'Ollama loaded ' + model + ' with a ' + size + '-token context window, which is too small for reliable agent work (' +
    RECOMMENDED_LOCAL_CONTEXT.toLocaleString('en-US') + '+ recommended). Restart Ollama with OLLAMA_CONTEXT_LENGTH=' + RECOMMENDED_LOCAL_CONTEXT +
    ' (or add "PARAMETER num_ctx ' + RECOMMENDED_LOCAL_CONTEXT + '" to a Modelfile). OASIS will compact early and send a smaller tool set until then.';
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
