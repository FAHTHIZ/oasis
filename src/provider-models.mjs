// Lists the models the configured provider actually serves (GET …/models), for
// `/model --list` and the /model picker. Uses the same key, key helper and gateway
// headers as normal requests. Bedrock, Vertex and Foundry have no simple list
// endpoint with the same credentials, so they return null (not supported) rather
// than a guess. Results are cached per endpoint for a few minutes.

const CACHE_MS = 5 * 60 * 1000;
// OpenRouter alone lists ~470 models in ~850 KB (Nov 2026), and the list is
// sorted before the cap, so a cap near that size silently drops whole
// providers late in the alphabet (qwen/, x-ai/, z-ai/).
const MAX_BYTES = 16 * 1024 * 1024;
const MAX_MODELS = 5000;
const cache = new Map();

function trimBase(baseURL) {
  return String(baseURL || '').replace(/\/+$/, '').replace(/\/(chat\/completions|responses|messages)$/, '');
}

export function modelsEndpoint(config = {}) {
  const protocol = String(config.protocol || 'openai-compatible');
  if (['bedrock', 'vertex', 'foundry'].includes(protocol)) return null;
  const base = trimBase(config.baseURL || config.baseUrl);
  if (!/^https?:\/\//i.test(base)) return null;
  if (protocol === 'anthropic') return (base.endsWith('/v1') ? base : base + '/v1') + '/models?limit=1000';
  return base + '/models';
}

// Accepts the OpenAI ({data:[{id}]}), Anthropic ({data:[{id}]}), Ollama ({models:[{name}]})
// and Gemini-style ({models:[{name:"models/x"}]}) shapes.
export function parseModelList(body) {
  const items = Array.isArray(body) ? body : Array.isArray(body && body.data) ? body.data : Array.isArray(body && body.models) ? body.models : [];
  const ids = [];
  for (const item of items) {
    const raw = typeof item === 'string' ? item : item && (item.id || item.name || item.model);
    if (typeof raw !== 'string') continue;
    const id = raw.replace(/^models\//, '').trim();
    if (id && id.length <= 200 && /^[\w.:/@+-]+$/.test(id)) ids.push(id);
  }
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b)).slice(0, MAX_MODELS);
}

async function headersFor(config, { env, cwd }) {
  const headers = { accept: 'application/json' };
  let apiKey = config.apiKey;
  if (!apiKey && config.apiKeyHelper) {
    const { apiKeyFromHelper } = await import('./api-key-helper.mjs');
    apiKey = await apiKeyFromHelper(config.apiKeyHelper, { env, cwd });
  }
  if (config.protocol === 'anthropic') {
    if (apiKey) headers['x-api-key'] = apiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (apiKey) {
    headers.authorization = 'Bearer ' + apiKey;
  }
  if (config.customHeaders || config.customHeadersHelper || env.ANTHROPIC_CUSTOM_HEADERS || env.OASIS_CUSTOM_HEADERS || env.OASIS_CUSTOM_HEADERS_HELPER) {
    const { customHeadersFor } = await import('./api-key-helper.mjs');
    const extra = await customHeadersFor(config, { env, cwd });
    for (const [name, value] of Object.entries(extra)) {
      if (name === 'accept' || name === 'anthropic-version') continue;
      if ((name === 'authorization' || name === 'x-api-key') && (headers.authorization || headers['x-api-key'])) continue;
      headers[name] = value;
    }
  }
  return headers;
}

/**
 * Returns { models: string[], endpoint } or { models: null, reason } — never throws.
 */
export async function listProviderModels(config = {}, { env = process.env, cwd = process.cwd(), fetchImpl = globalThis.fetch, timeoutMs = 5000, refresh = false } = {}) {
  const endpoint = modelsEndpoint(config);
  if (!endpoint) return { models: null, reason: config.protocol && ['bedrock', 'vertex', 'foundry'].includes(config.protocol) ? 'Listing models is not supported for ' + config.protocol + '; see the provider console.' : 'No provider endpoint is configured.' };
  const key = endpoint + '\0' + (config.apiKey ? String(config.apiKey).slice(-6) : '');
  const hit = cache.get(key);
  if (!refresh && hit && Date.now() - hit.at < CACHE_MS) return { models: hit.models, endpoint };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(500, Number(timeoutMs) || 5000));
  try {
    const headers = await headersFor(config, { env, cwd });
    const response = await fetchImpl(endpoint, { headers, signal: controller.signal, redirect: 'error' });
    if (!response.ok) return { models: null, endpoint, reason: 'The provider answered HTTP ' + response.status + ' for ' + new URL(endpoint).pathname + '.' };
    const length = Number(response.headers && response.headers.get && response.headers.get('content-length') || 0);
    if (length > MAX_BYTES) return { models: null, endpoint, reason: 'The model list was too large.' };
    const text = await response.text();
    if (text.length > MAX_BYTES) return { models: null, endpoint, reason: 'The model list was too large.' };
    const models = parseModelList(JSON.parse(text));
    cache.set(key, { at: Date.now(), models });
    return { models, endpoint };
  } catch (error) {
    return { models: null, endpoint, reason: controller.signal.aborted ? 'The provider did not answer within ' + Math.round(timeoutMs / 1000) + 's.' : 'Could not list models: ' + String(error && error.message || error).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

export function clearProviderModelCache() { cache.clear(); }
