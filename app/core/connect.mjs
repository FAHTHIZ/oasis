// Smart connect for the universal app: the user pastes anything that points
// at a model (an API key, a provider or model web page, a local server
// address, or a bare model name) and OASIS works out the provider, lists the
// models the key can use, ranks them for agentic coding, proves the best one
// can call tools, and locks the connection in. Nothing here touches the DOM,
// so the same module runs in the browser and under `node --test`.

import { PRESETS, ProviderError, testProvider, briefFailure } from './providers.mjs';

/* ---------- Recognising what was pasted ---------- */

// Key shapes, most specific first. `providers` is the probe order when a
// prefix is shared (DeepSeek, Moonshot and old OpenAI keys all start sk-).
const KEY_RULES = [
  { test: /^sk-ant-[A-Za-z0-9_-]{20,}$/, providers: ['anthropic'] },
  { test: /^sk-or-[A-Za-z0-9_-]{20,}$/, providers: ['openrouter'] },
  // Google AI Studio now issues AQ. authorization keys as well as legacy AIza keys.
  { test: /^AQ\.[A-Za-z0-9_-]{20,}$/, providers: ['gemini'] },
  { test: /^AIza[0-9A-Za-z_-]{30,}$/, providers: ['gemini'] },
  { test: /^gsk_[A-Za-z0-9]{20,}$/, providers: ['groq'] },
  { test: /^xai-[A-Za-z0-9]{20,}$/, providers: ['xai'] },
  { test: /^hf_[A-Za-z0-9]{20,}$/, providers: ['huggingface'] },
  { test: /^nvapi-[A-Za-z0-9_-]{20,}$/, providers: ['nvidia'] },
  { test: /^csk-[A-Za-z0-9]{20,}$/, providers: ['cerebras'] },
  { test: /^fw_[A-Za-z0-9]{16,}$/, providers: ['fireworks'] },
  { test: /^tgp_v1_[A-Za-z0-9_-]{20,}$/, providers: ['together'] },
  // The unified key a self-hosted FreeLLMAPI gateway issues.
  { test: /^freellmapi-[A-Za-z0-9_-]{24,}$/, providers: ['freellmapi'] },
  { test: /^sk-(proj|svcacct|admin)-[A-Za-z0-9_-]{20,}$/, providers: ['openai'] },
  { test: /^sk-[a-f0-9]{32}$/, providers: ['deepseek', 'moonshot', 'openai'] },
  { test: /^sk-[A-Za-z0-9]{40,}$/, providers: ['openai', 'moonshot', 'deepseek'] },
  { test: /^sk-[A-Za-z0-9_-]{20,}$/, providers: ['openai', 'deepseek', 'moonshot'] },
  { test: /^[a-f0-9]{64}$/, providers: ['together', 'mistral'] },
  { test: /^[A-Za-z0-9]{32}$/, providers: ['mistral', 'together'] }
];

// Self-hosted gateways on loopback that forward to cloud providers.
const GATEWAYS = new Set(['omniroute', 'freellmapi']);

const GITHUB_TOKEN = /^(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})$/;
const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|[a-z0-9-]+\.local)$/i;
const LOCAL_SERVERS = [
  { provider: 'ollama', origin: 'http://localhost:11434' },
  { provider: 'lmstudio', origin: 'http://localhost:1234' },
  { provider: 'llamacpp', origin: 'http://localhost:8080' },
  { provider: 'custom', origin: 'http://localhost:8000' }
];

const LOCAL_SERVER_NAMES = { 11434: 'Ollama', 1234: 'LM Studio', 8080: 'llama.cpp' };

/**
 * A readable name for a model server address: "Ollama (this device)" for
 * 127.0.0.1:11434 rather than the raw host, the host name for remote servers.
 */
export function serverLabel(baseURL) {
  let url;
  try { url = new URL(baseURL); } catch { return ''; }
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(url.hostname);
  const name = LOCAL_SERVER_NAMES[url.port];
  if (loopback) return (name || 'Local server :' + (url.port || (url.protocol === 'https:' ? 443 : 80))) + ' (this device)';
  if (name && LOCAL_HOST.test(url.hostname)) return name + ' (' + url.host + ')';
  return url.host;
}

/** Which providers a key could belong to, in probe order. [] when it is not a key. */
export function detectKey(value) {
  const key = String(value || '').trim();
  for (const rule of KEY_RULES) if (rule.test.test(key)) return rule.providers.slice();
  return [];
}

export function isGitHubToken(value) {
  return GITHUB_TOKEN.test(String(value || '').trim());
}

/** Shows enough of a secret to recognise it, never enough to use it. */
export function maskSecret(value) {
  const text = String(value || '');
  if (text.length <= 10) return '•••';
  return text.slice(0, Math.min(6, text.indexOf('-') > 0 ? text.indexOf('-') + 1 : 4)) + '…' + text.slice(-4);
}

function asURL(token) {
  let text = String(token || '').trim().replace(/[),.;]+$/, '');
  if (!text) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/|$)/i.test(text)) text = 'http://' + text;
    else if (/^(huggingface\.co|hf\.co|ollama\.com|openrouter\.ai|www\.)/i.test(text)) text = 'https://' + text;
    else return null;
  }
  try {
    const url = new URL(text);
    return /^https?:$/.test(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

const HF_RESERVED = new Set(['spaces', 'datasets', 'docs', 'settings', 'models', 'organizations', 'blog', 'papers', 'learn', 'collections', 'join', 'login', 'pricing', 'tasks', 'api', 'chat', 'inference-endpoints']);

/**
 * What a pasted URL means. Returns one of:
 *   { kind: 'huggingface', model, gguf }   a model page on the Hugging Face Hub
 *   { kind: 'ollama-library', model }      a model page on ollama.com
 *   { kind: 'openrouter', model }          a model page on openrouter.ai
 *   { kind: 'endpoint', url, local }       any server that may speak an LLM API
 *   null                                   not a URL
 */
export function interpretURL(token) {
  const url = asURL(token);
  if (!url) return null;
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  if ((host === 'huggingface.co' || host === 'hf.co') && parts.length >= 2 && !HF_RESERVED.has(parts[0])) {
    const model = parts[0] + '/' + parts[1];
    return { kind: 'huggingface', model, gguf: /gguf/i.test(parts[1]) };
  }
  if (host === 'huggingface.co' && parts[0] === 'models' && url.searchParams.get('search')) return { kind: 'huggingface-search', query: url.searchParams.get('search') };
  if (host === 'ollama.com' && parts.length >= 2) {
    const name = parts[0] === 'library' ? parts[1] : parts[0] + '/' + parts[1];
    const tag = parts[2] && !/^(tags|blobs)$/.test(parts[2]) ? ':' + parts[2] : '';
    return { kind: 'ollama-library', model: name + tag };
  }
  if (host === 'openrouter.ai' && parts.length >= 2 && !/^(api|docs|settings|keys|models|chat|rankings|activity|credits|apps)$/.test(parts[0])) {
    return { kind: 'openrouter', model: parts[0] + '/' + parts[1] };
  }
  return { kind: 'endpoint', url: url.toString().replace(/\/+$/, ''), local: LOCAL_HOST.test(url.hostname) };
}

// "qwen3-coder:30b", "llama3.2", "Qwen/Qwen3-Coder-30B-A3B-Instruct",
// "anthropic/claude-sonnet-5". Plain English words are not model names.
const MODEL_NAME = /^(?=.*[\d:/._-])[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9._-]+)?(:[A-Za-z0-9._-]+)?$/;

/**
 * Splits pasted text into the parts smart connect understands. `rest` is
 * whatever is left (so "here is my key sk-... now fix the tests" still runs
 * the task after connecting).
 */
export function parsePaste(text) {
  const result = { keys: [], urls: [], models: [], githubTokens: [], local: false, rest: '' };
  const leftover = [];
  for (const raw of String(text || '').split(/\s+/)) {
    const token = raw.replace(/^["'`<(]+|["'`>),;]+$/g, '');
    if (!token) continue;
    if (isGitHubToken(token)) { result.githubTokens.push(token); continue; }
    const providers = detectKey(token);
    // KEY_RULES are anchored format checks; do not reject valid opaque keys
    // merely because a provider's format contains no numeric character.
    if (providers.length) { result.keys.push({ value: token, providers }); continue; }
    const url = interpretURL(token);
    if (url) { result.urls.push(url); continue; }
    leftover.push(raw);
  }
  const words = leftover.join(' ').trim();
  if (/^(use\s+)?(ollama|lm ?studio|llama\.?cpp|local( model)?s?|my computer|offline)$/i.test(words)) result.local = true;
  else if ((result.keys.length || result.urls.length) && leftover.length <= 2 && leftover.every((word) => MODEL_NAME.test(word))) result.models.push(...leftover);
  else result.rest = (result.keys.length || result.urls.length || result.githubTokens.length)
    ? words.replace(/^((here'?s|here|is|this|use|my|the|an?|api|key|token|url|link|model|for|it|please|and|now|then|so)\b[\s:,.-]*)+/i, '').trim()
    : words;
  return result;
}

/**
 * True when a chat message is (mostly) connection material rather than a task:
 * a key, a model link or a local-server address. Ordinary web links in a task
 * ("summarise https://example.com/post") stay a task.
 */
export function looksLikeConnection(text) {
  const parsed = parsePaste(text);
  if (parsed.keys.length || parsed.githubTokens.length) return true;
  if (parsed.local && !parsed.rest) return true;
  if (!parsed.urls.length || parsed.rest) return false;
  return parsed.urls.every((url) => url.kind !== 'endpoint' || url.local || /\/v1\b|\/api\/(tags|chat)|:\d{2,5}(\/|$)|ollama|openai|inference|router|llm|model/i.test(url.url));
}

/* ---------- Ranking models ---------- */

const NOT_CHAT = /(embed|embedding|tts|whisper|transcri|speech|audio|realtime|dall-?e|\bimage|imagen|moderation|rerank|guard|safety|davinci|babbage|\bada\b|similarity|\bclip\b|diffusion|\bflux\b|sdxl|\bveo|\bsora|lyria|\baqa\b|ocr|\bbge\b|\be5-|nomic|-search-|search-preview|computer-use|deep-research|-native-audio|live-|-live\b)/i;

// Rough agentic-coding quality by family. Versions inside a family break ties.
const FAMILIES = [
  [/claude|fable|opus|sonnet|haiku/i, 92],
  [/\bgpt-?\d|\bgpt\b|codex|\bo[1-9](-|$)/i, 90],
  [/gemini/i, 88],
  [/grok/i, 84],
  [/deepseek/i, 84],
  [/kimi|moonshot/i, 84],
  [/qwen|qwq/i, 82],
  [/glm|zhipu|z-ai/i, 82],
  [/minimax/i, 78],
  [/devstral|codestral|mistral|magistral|mixtral/i, 74],
  [/nemotron|llama/i, 68],
  [/gemma|phi|granite|olmo|smol/i, 58]
];

function versionOf(id) {
  const match = String(id).toLowerCase().match(/(?:^|[^a-z0-9])(?:[a-z]+-?)?v?(\d+(?:[.-]\d)?)(?![\d]*b\b)/);
  if (!match) return 0;
  const value = Number(match[1].replace('-', '.'));
  return Number.isFinite(value) && value < 50 ? value : 0;
}

function paramsOf(id) {
  const match = String(id).toLowerCase().match(/(\d+(?:\.\d+)?)b(?:\b|-|_|$)/);
  return match ? Number(match[1]) : 0;
}

/** Higher is better for an agent that edits code and calls tools. */
export function scoreModel(id) {
  const text = String(id || '');
  if (!text || NOT_CHAT.test(text)) return -Infinity;
  const lower = text.toLowerCase();
  let score = 50;
  for (const [pattern, base] of FAMILIES) if (pattern.test(lower)) { score = base; break; }
  // Version, size and date come from the model's own name: a digit in a
  // provider or gateway prefix (llm7/…, 01-ai/…) is not a model version.
  const name = lower.slice(lower.lastIndexOf('/') + 1);
  score += Math.min(versionOf(name), 12) * 2;
  if (/fable/.test(lower)) score += 12;
  else if (/opus|\bultra|-max\b|-pro\b|\bpro\b|-sol\b/.test(lower)) score += 9;
  else if (/sonnet|plus|large|-medium/.test(lower)) score += 4;
  if (/haiku|flash|-air\b|small|-mini|mini-|\bmini\b|turbo/.test(lower)) score -= 8;
  if (/nano|lite|tiny|micro/.test(lower)) score -= 14;
  if (/coder|codex|devstral|codestral|-code\b|code-/.test(lower)) score += 4;
  if (/instruct|chat|thinking|reasoner|latest/.test(lower)) score += 1;
  if (/preview|exp\b|-exp-|beta|alpha/.test(lower)) score -= 2;
  if (/:free\b/.test(lower)) score -= 3;
  if (/vision|-vl\b|-vl-|ocr/.test(lower)) score -= 4;
  // Specialist models answer chat requests but are tuned for something else.
  if (/robotics|-er-\d|omni|nano-banana|learnlm|medgemma|-math\b|translate|guardian/.test(lower)) score -= 30;
  if (/base\b|-base-/.test(lower)) score -= 20;
  const params = paramsOf(name);
  if (params) score += params < 4 ? -22 : params < 8 ? -14 : params < 15 ? -7 : params < 30 ? -2 : params >= 200 ? 4 : 2;
  const date = name.match(/20(2\d)[-]?(\d{2})[-]?(\d{2})?/);
  if (date) score += (Number(date[1]) - 20) * 0.3 + Number(date[2]) * 0.02;
  return score;
}

/** Chat models first, best first. Non-chat models (embeddings, speech, images) are dropped. */
export function rankModels(ids) {
  const seen = new Set();
  return ids
    .map((id) => String(id || '').replace(/^models\//, '').trim())
    .filter((id) => id && !seen.has(id) && seen.add(id))
    .map((id) => ({ id, score: scoreModel(id) }))
    .filter((entry) => entry.score > -Infinity)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .map((entry) => entry.id);
}

/* ---------- Talking to providers ---------- */

function trimSlash(url) {
  return String(url || '').replace(/\/+$/, '');
}

async function timed(fetchImpl, url, options = {}, timeoutMs = 8000) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, { ...options, signal: controller ? controller.signal : undefined });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function modelHeaders(connection) {
  if (connection.protocol === 'anthropic') {
    return { 'x-api-key': connection.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
  }
  return connection.apiKey ? { authorization: 'Bearer ' + connection.apiKey } : {};
}

function idsFrom(body) {
  const list = Array.isArray(body) ? body : body && (body.data || body.models || body.result || []);
  return (Array.isArray(list) ? list : []).map((item) => (typeof item === 'string' ? item : item && (item.id || item.name || item.model))).filter(Boolean);
}

/**
 * What a model list says about each model beyond its ID. Some servers mark
 * models that need a paid key (LLM7 `tier: "pro"`, `usage_based_only`) or that
 * cannot call tools (`tools_calling: false`, OpenRouter `supported_parameters`
 * without "tools"). Probing those first on a keyless connection wastes the
 * setup budget on answers that can only be 401 or "no tools".
 */
function modelHints(body) {
  const list = Array.isArray(body) ? body : body && (body.data || body.models || body.result || []);
  const paid = new Set();
  const noTools = new Set();
  // Gateways (FreeLLMAPI) mark models they cannot serve right now: no
  // upstream key at all (skip), or a free tier used up for now (try later).
  const unavailable = new Set();
  const exhausted = new Set();
  // Alias slots ("claude-opus-4-5": "Opus slot (auto-routed to a free
  // model)") are not the model their name suggests; prefer named models.
  const alias = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    if (!item || typeof item !== 'object') continue;
    const id = String(item.id || item.name || item.model || '').replace(/^models\//, '').trim();
    if (!id) continue;
    if (item.available === false || /^(no_?key|needs_?key|disabled)$/i.test(String(item.unavailable_reason || '')) || /^needs_?key$/i.test(String(item.execution_status || ''))) unavailable.add(id);
    if (/^(exhausted|rate_?limited|cooldown)$/i.test(String(item.execution_status || ''))) exhausted.add(id);
    if (typeof item.name === 'string' && /auto-?routed|\balias\b|\bslot\b/i.test(item.name)) alias.add(id);
    const tier = String(item.tier || item.plan || '').toLowerCase();
    if (/^(pro|paid|premium|enterprise)$/.test(tier) || item.usage_based_only === true || item.requires_key === true) paid.add(id);
    const caps = item.capabilities && typeof item.capabilities === 'object' ? item.capabilities : {};
    if (item.tools_calling === false || caps.tools === false || caps.function_calling === false
      || (Array.isArray(item.supported_parameters) && item.supported_parameters.length && !item.supported_parameters.includes('tools'))) noTools.add(id);
  }
  return { paid, noTools, unavailable, exhausted, alias };
}

/**
 * Drops models the server says it cannot serve, then moves models a keyless
 * connection cannot use, models without tools, alias slots and models whose
 * free tier is used up for now towards the end, in that order of weight.
 */
function orderByHints(ranked, hints, { keyless = false } = {}) {
  if (!hints) return ranked;
  const has = (set, id) => Boolean(set && set.has(id));
  const bucket = (id) => (keyless && hints.paid.has(id) ? 8 : 0) + (hints.noTools.has(id) ? 4 : 0) + (has(hints.alias, id) ? 2 : 0) + (has(hints.exhausted, id) ? 1 : 0);
  return ranked.filter((id) => !has(hints.unavailable, id)).map((id, index) => ({ id, index, rank: bucket(id) })).sort((a, b) => a.rank - b.rank || a.index - b.index).map((entry) => entry.id);
}

/**
 * Lists the models a connection can use. Throws ProviderError with the HTTP
 * status when the server answers but refuses (so a 401 means "wrong key").
 */
async function listModels(connection, { fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = 8000 } = {}) {
  const base = trimSlash(connection.baseURL || (connection.protocol === 'anthropic' ? 'https://api.anthropic.com' : ''));
  const url = connection.protocol === 'anthropic' ? base + '/v1/models?limit=100' : base + '/models';
  const response = await timed(fetchImpl, url, { headers: modelHeaders(connection) }, timeoutMs);
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ProviderError('The server answered ' + response.status + ' when listing models. ' + detail.slice(0, 200), { status: response.status });
  }
  const body = await response.json().catch(() => null);
  const ids = idsFrom(body);
  if (!ids.length && !body) throw new ProviderError('The server did not return a model list.');
  Object.defineProperty(ids, 'hints', { value: modelHints(body), enumerable: false });
  return ids;
}

async function ollamaTags(origin, fetchImpl, timeoutMs) {
  const response = await timed(fetchImpl, origin + '/api/tags', {}, timeoutMs);
  if (!response.ok) throw new ProviderError('Not an Ollama server (' + response.status + ').', { status: response.status });
  const body = await response.json();
  if (!body || !Array.isArray(body.models)) throw new ProviderError('Not an Ollama server.');
  return body.models.map((model) => model.name || model.model).filter(Boolean);
}

/** Asks a local Ollama to download a model, reporting progress as it goes. */
async function ollamaPull(origin, model, { fetchImpl = globalThis.fetch.bind(globalThis), onStatus = () => {} } = {}) {
  const response = await fetchImpl(origin + '/api/pull', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, stream: true }) });
  if (!response.ok) throw new ProviderError('Ollama could not download ' + model + ' (' + response.status + ').', { status: response.status });
  if (!response.body || !response.body.getReader) return;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let last = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event.error) throw new ProviderError('Ollama: ' + event.error);
      const percent = event.total ? Math.floor((event.completed || 0) / event.total * 100) : null;
      if (percent === null || percent !== last) {
        last = percent;
        onStatus({ step: 'download', text: 'Downloading ' + model + (percent !== null ? ' — ' + percent + '%' : ' — ' + (event.status || '')), percent });
      }
    }
  }
}

function makeConnection(provider, overrides = {}) {
  const preset = PRESETS[provider] || PRESETS.custom;
  return {
    id: overrides.id || provider + '-' + Math.random().toString(36).slice(2, 8),
    provider,
    label: overrides.label || preset.label,
    protocol: overrides.protocol || preset.protocol,
    baseURL: trimSlash(overrides.baseURL !== undefined ? overrides.baseURL : preset.baseURL),
    apiKey: overrides.apiKey || '',
    models: overrides.models || [],
    local: Boolean(overrides.local),
    ...(overrides.skipModels && overrides.skipModels.length ? { skipModels: overrides.skipModels } : {}),
    addedAt: Date.now()
  };
}

/**
 * Proves a model can hold a conversation and call a tool. Tries the ranked
 * models in order and returns the first that works, so a key without access
 * to the flagship still lands on the best model it can use.
 */
// Providers often name the replacement when they retire a model, for example
// Google's "no longer available to new users. Please update your code to use
// models/gemini-3.8-flash". Returns that model ID, or ''.
export function suggestedModel(message) {
  const match = /\b(?:use|switch to|migrate to|try)\s+(?:the\s+)?(?:model\s+)?[`'"]?(?:models\/)?([A-Za-z0-9][A-Za-z0-9._:/-]{2,80}?)[`'"]?(?=[\s,;)]|\.(?:\s|$)|$)/i.exec(String(message || ''));
  // A model ID has a digit or a dash; "try again later" is not a suggestion.
  return match && /[\d-]/.test(match[1]) ? match[1] : '';
}


/**
 * Proves a model can hold a conversation and call a tool. Tries the ranked
 * models in order and returns the first that works, so a key without access
 * to the flagship still lands on the best model it can use.
 *
 * `tries` bounds the failures that say nothing about the next model (bad
 * output, odd errors). Retired models (404), models the key has no quota for
 * and models that are busy right now are cheap to rule out and common on free
 * tiers (a free Gemini key has no quota for the Pro models, and the older
 * ones are retired), so they only count against a larger `maxAttempts`.
 * Those models are returned as `unusable` so they never become fallbacks.
 */
async function lockIn(connection, ranked, { fetchImpl, onStatus, tries = 4, preferred = [], maxAttempts = 12, retryDelayMs = 1200, probeTimeoutMs, budgetMs }) {
  // A model on this device is slow, not busy: the first request loads it from
  // disk, and a 4B model on 2 CPUs writes ~6 tokens/s. 25 s failed a real
  // qwen3:4b on Ollama that a 120 s window passes; cloud keeps the short limit.
  if (probeTimeoutMs === undefined) probeTimeoutMs = connection.local ? 120000 : 25000;
  if (budgetMs === undefined) budgetMs = connection.local ? 300000 : 120000;
  const order = [...preferred.filter((id) => !ranked.includes(id)), ...preferred.filter((id) => ranked.includes(id)), ...ranked.filter((id) => !preferred.includes(id))];
  const failures = [];
  const unusable = [];
  const gateway = GATEWAYS.has(connection.provider);
  const skippedProviders = new Set();
  // Hundreds of listed models: allow more chat-only answers before settling.
  if (gateway) tries = Math.max(tries, 8);
  const tried = new Set();
  let noTools = null;
  let hardFailures = 0;
  let attempts = 0;
  let cheap = 0;
  const limit = Math.max(maxAttempts, tries, preferred.length);
  // Stop starting new probes after `budgetMs` so setup never hangs for minutes.
  const deadline = Date.now() + budgetMs;
  // A tiny output cap keeps the probe cheap, but reasoning models (Gemini 3,
  // o-series, R1-style) can spend it all on hidden thinking and come back
  // empty. An empty answer is a truncation, not a "no", so ask once more with
  // room to think before judging the model.
  const probe = async (model) => {
    const first = await testProvider({ ...connection, model, maxRetries: 0, maxTokens: 64 }, fetchImpl, { timeoutMs: probeTimeoutMs });
    if (first.toolCalling || String(first.reply || '').trim()) return first;
    // A local thinking model (qwen3, R1-style) on a slow computer can't finish the
    // longer answer in time. "Busy" would be the wrong advice, so say why.
    if (connection.local) {
      try { return await testProvider({ ...connection, model, maxRetries: 0, maxTokens: 2048 }, fetchImpl, { timeoutMs: probeTimeoutMs }); }
      catch (error) {
        if (!error || !error.timedOut) throw error;
        throw Object.assign(new ProviderError(model + ' spends its answers on hidden thinking and could not finish one within ' + Math.round(probeTimeoutMs / 1000) + ' seconds on this computer. Use a model without hidden thinking, such as qwen2.5-coder.', { status: 0 }), { timedOut: true, thinking: true });
      }
    }
    return testProvider({ ...connection, model, maxRetries: 0, maxTokens: 2048 }, fetchImpl, { timeoutMs: probeTimeoutMs });
  };
  while (order.length && attempts < limit && hardFailures < Math.max(tries, preferred.length) && (attempts === 0 || Date.now() < deadline)) {
    const model = order.shift();
    if (tried.has(model)) continue;
    tried.add(model);
    attempts += 1;
    const started = Date.now();
    onStatus({ step: 'test', text: 'Testing ' + model + (connection.local && attempts === 1 ? '… (the first answer from a local model can take a minute while it loads)' : '…'), model });
    try {
      let result;
      try { result = await probe(model); }
      catch (error) {
        // One short retry for "busy right now" before moving on.
        if (classifyFailure(error) !== 'server' || error.timedOut || !retryDelayMs || Date.now() > deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        result = await probe(model);
      }
      if (result.toolCalling) return { model, toolCalling: true, failures, unusable };
      noTools = noTools || model;
      hardFailures += 1;
      failures.push({ model, reason: 'answered but did not call the test tool' });
    } catch (error) {
      const kind = classifyFailure(error);
      failures.push({ model, reason: error.message, kind, status: error.status });
      // An instant "no quota" or "retired" answer is free to rule out, so it
      // does not use up an attempt; only the time budget bounds those.
      if ((kind === 'model' || kind === 'credits' || kind === 'rate') && Date.now() - started < 3000 && cheap < 40) { attempts -= 1; cheap += 1; }
      // A gateway (OmniRoute) lists every provider it knows, connected or not.
      // A provider-level failure (no account, upstream down) rules out the rest
      // of that provider's models at once instead of one probe each.
      const prefix = gateway && model.includes('/') ? model.slice(0, model.indexOf('/')) : '';
      if (prefix && !error.timedOut && (kind === 'auth' || kind === 'server' || kind === 'credits')) {
        attempts -= 1;
        skippedProviders.add(prefix);
        for (const id of ranked) if (id.startsWith(prefix + '/') && !unusable.includes(id)) unusable.push(id);
        for (let at = order.length - 1; at >= 0; at--) if (order[at].startsWith(prefix + '/')) order.splice(at, 1);
        if (skippedProviders.size > 60) break;
        continue;
      }
      // The model list answered without a key, so a 401 here is about this
      // model (a paid tier on a free server), not a wrong key: rule it out
      // and keep going. Only when every model says so is a key really needed.
      if (kind === 'auth' && !connection.apiKey && !connection.local) {
        failures[failures.length - 1].kind = 'needs-key';
        unusable.push(model);
        if (Date.now() - started < 3000 && cheap < 80) { attempts -= 1; cheap += 1; }
        continue;
      }
      if (kind === 'auth' || kind === 'network') throw error;
      if (kind === 'model' || kind === 'credits') unusable.push(model);
      if (!['model', 'credits', 'rate', 'server'].includes(kind)) hardFailures += 1;
      const next = suggestedModel(error.message);
      if (next && !tried.has(next) && next !== model && (ranked.includes(next) || preferred.includes(next))) {
        const at = order.indexOf(next);
        if (at >= 0) order.splice(at, 1);
        order.unshift(next);
      }
    }
  }
  if (noTools) return { model: noTools, toolCalling: false, failures, unusable };
  if (!failures.length) throw new ProviderError('This connection has no chat models.');
  if (failures.every((failure) => failure.kind === 'needs-key')) {
    throw new ProviderError('This server lists its models without a key but needs an API key to use them (' + failures.length + ' tried). Paste the address and the key together, separated by a space.', { status: 401 });
  }
  const allCredits = failures.every((failure) => failure.kind === 'credits');
  const lines = failures.slice(0, 8).map((failure) => '  ' + failure.model + ': ' + briefFailure(failure.reason, failure.status));
  if (failures.length > 8) lines.push('  …and ' + (failures.length - 8) + ' more');
  const daily = failures.some((failure) => /per ?day|PerDay/i.test(failure.reason));
  const hint = daily ? ' The daily quota is used up on these models; it resets within a day, or add billing.'
    : failures.some((failure) => failure.kind === 'server' || failure.kind === 'rate')
    ? ' Some models were busy or rate limited; try again in a minute.'
    : allCredits ? ' The key has no credit or quota for these models; add billing or use another key.' : '';
  if (gateway) lines.push('  This gateway lists models from providers it is not connected to. Connect a provider in its dashboard, or paste the address and key with a model name after them.');
  throw new ProviderError('No model on this connection answered (' + failures.length + ' tried).' + hint + '\n' + lines.join('\n'), { status: allCredits ? 402 : 0 });
}

/**
 * The whole paste-to-ready flow. `input` is the pasted text. `known` holds
 * keys already on the device (for example an hf_ token when the user later
 * pastes a Hugging Face model link). Resolves to
 *   { connection, model, toolCalling, notes, githubToken }
 * or throws ProviderError with a message written for the user.
 */
export async function smartConnect(input, { fetchImpl = globalThis.fetch.bind(globalThis), onStatus = () => {}, known = [], test = true, allowPull = true, tries = 4, retryDelayMs, probeTimeoutMs } = {}) {
  const parsed = parsePaste(input);
  const notes = [];
  const githubToken = parsed.githubTokens[0] || '';
  const say = (text, step = 'info') => onStatus({ step, text });
  const finish = async (connection, preferred = []) => {
    say('Found ' + connection.models.length + ' model' + (connection.models.length === 1 ? '' : 's') + ' on ' + connection.label + '.', 'models');
    if (!connection.models.length && !preferred.length) throw new ProviderError(connection.label + ' answered but lists no chat models.');
    if (!test) return { connection, model: preferred[0] || connection.models[0], toolCalling: null, notes, githubToken };
    const locked = await lockIn(connection, connection.models, { fetchImpl, onStatus, tries, preferred, ...(retryDelayMs !== undefined ? { retryDelayMs } : {}), ...(probeTimeoutMs !== undefined ? { probeTimeoutMs } : {}) });
    const unusable = new Set(locked.unusable || []);
    const rest = connection.models.filter((id) => id !== locked.model);
    // Models that are retired or have no quota go last, so they never become fallbacks.
    connection.models = [locked.model, ...rest.filter((id) => !unusable.has(id)), ...rest.filter((id) => unusable.has(id))];
    if (!locked.toolCalling) notes.push(locked.model + ' answered but did not call tools in the test, so it may only chat. Paste another model to use as the agent.');
    say('Ready: ' + locked.model + ' on ' + connection.label + '.', 'ready');
    return { connection, model: locked.model, toolCalling: locked.toolCalling, notes, githubToken, unusable: [...unusable] };
  };
  const keyFor = (provider) => {
    const pasted = parsed.keys.find((key) => key.providers.includes(provider));
    if (pasted) return pasted.value;
    const stored = known.find((entry) => entry.provider === provider && entry.apiKey);
    return stored ? stored.apiKey : '';
  };

  // 1. A model page link.
  const page = parsed.urls.find((url) => url.kind !== 'endpoint');
  if (page && page.kind === 'ollama-library') {
    say('That is an Ollama model page. Looking for Ollama on this device…', 'detect');
    return connectOllama({ want: page.model, fetchImpl, say, allowPull, finish });
  }
  if (page && page.kind === 'huggingface') {
    say('That is a Hugging Face model: ' + page.model + '.', 'detect');
    if (page.gguf || !keyFor('huggingface')) {
      const local = await findOllama(fetchImpl).catch(() => null);
      if (local) return connectOllama({ want: 'hf.co/' + page.model, fetchImpl, say, allowPull, finish, origin: local });
    }
    const key = keyFor('huggingface');
    if (!key) throw new ProviderError('To run ' + page.model + ' through Hugging Face, paste a Hugging Face token (hf_…) from huggingface.co/settings/tokens. To run it on this device instead, start Ollama and paste the link again.', { status: 401 });
    const connection = makeConnection('huggingface', { apiKey: key });
    connection.models = rankModels(await listModels(connection, { fetchImpl }).catch(() => []));
    return finish(connection, [page.model]);
  }
  if (page && page.kind === 'openrouter') {
    const key = keyFor('openrouter');
    if (!key) throw new ProviderError('To use ' + page.model + ', paste an OpenRouter key (sk-or-…) from openrouter.ai/keys, or paste the key and the link together.', { status: 401 });
    const connection = makeConnection('openrouter', { apiKey: key });
    connection.models = rankModels(await listModels(connection, { fetchImpl }));
    return finish(connection, [page.model]);
  }
  if (page && page.kind === 'huggingface-search') throw new ProviderError('That is a search page. Open the model you want on Hugging Face and paste its link.');

  // 2. A server address (local or remote).
  const endpoint = parsed.urls.find((url) => url.kind === 'endpoint');
  if (endpoint) {
    say('Checking ' + endpoint.url + '…', 'detect');
    const apiKey = parsed.keys[0] ? parsed.keys[0].value : '';
    const connection = await probeEndpoint(endpoint.url, { apiKey, fetchImpl, local: endpoint.local });
    say('It speaks the ' + (connection.provider === 'ollama' ? 'Ollama' : connection.protocol === 'anthropic' ? 'Anthropic' : 'OpenAI-compatible') + ' API.', 'detect');
    if (connection.provider === 'ollama' && parsed.models[0] && !connection.models.includes(parsed.models[0]) && allowPull) {
      await ollamaPull(connection.baseURL.replace(/\/v1$/, ''), parsed.models[0], { fetchImpl, onStatus });
      connection.models.unshift(parsed.models[0]);
    }
    return finish(connection, parsed.models);
  }

  // 3. "ollama" / "local" on its own: scan the usual local ports.
  if (parsed.local && !parsed.keys.length) {
    say('Looking for a model server on this device…', 'detect');
    const found = await scanLocal({ fetchImpl });
    if (!found.length) throw new ProviderError('No local model server answered. Start Ollama (OLLAMA_ORIGINS=* ollama serve) or LM Studio\'s server, then try again.');
    return finish(found[0], parsed.models);
  }

  // 4. An API key.
  const key = parsed.keys[0];
  if (!key) throw new ProviderError(parsed.githubTokens.length ? 'GITHUB_ONLY' : 'Paste an API key (for example sk-or-…, sk-ant-…, AQ.…/AIza…, hf_…) or a model link from Ollama, Hugging Face or OpenRouter.');
  const errors = [];
  for (const provider of key.providers) {
    const connection = makeConnection(provider, { apiKey: key.value });
    say('Looks like a ' + connection.label + ' key. Checking it…', 'detect');
    try {
      connection.models = rankModels(await listModels(connection, { fetchImpl }));
      say(connection.label + ' accepted the key.', 'detect');
      return await finish(connection, parsed.models);
    } catch (error) {
      errors.push({ provider, error });
      if (classifyFailure(error) !== 'auth' && !(error instanceof TypeError) && error.status !== 404) throw error;
    }
  }
  const auth = errors.find((entry) => classifyFailure(entry.error) === 'auth');
  if (auth) throw new ProviderError((key.providers.length > 1 ? 'None of ' + key.providers.map((id) => PRESETS[id].label).join(', ') : PRESETS[key.providers[0]].label) + ' accepted this key. Check that it was copied whole and has not been revoked.', { status: 401 });
  throw new ProviderError('Could not reach ' + PRESETS[key.providers[0]].label + ' from this device. Check the internet connection. ' + (errors[0] ? errors[0].error.message : ''));
}

async function findOllama(fetchImpl, origins = ['http://localhost:11434', 'http://127.0.0.1:11434']) {
  for (const origin of origins) {
    try {
      await ollamaTags(origin, fetchImpl, 1500);
      return origin;
    } catch {}
  }
  return null;
}

async function connectOllama({ want, fetchImpl, say, allowPull, finish, origin }) {
  const found = origin || (await findOllama(fetchImpl));
  if (!found) throw new ProviderError('Ollama is not running on this device. Install it from ollama.com, start it with OLLAMA_ORIGINS=* ollama serve, then paste the link again. Or paste an API key to use a hosted model.');
  let models = await ollamaTags(found, fetchImpl, 4000);
  const has = models.some((name) => name === want || name === want + ':latest' || name.split(':')[0] === want);
  if (!has) {
    if (!allowPull) throw new ProviderError(want + ' is not downloaded in Ollama yet.');
    say('Downloading ' + want + ' into Ollama. Large models take a while; you can keep this open.', 'download');
    await ollamaPull(found, want, { fetchImpl, onStatus: (status) => say(status.text, 'download') });
    models = await ollamaTags(found, fetchImpl, 4000);
  }
  const exact = models.find((name) => name === want) || models.find((name) => name === want + ':latest') || models.find((name) => name.split(':')[0] === want) || want;
  const connection = makeConnection('ollama', { baseURL: found + '/v1', local: true, models: [exact, ...rankModels(models).filter((name) => name !== exact)] });
  return finish(connection, [exact]);
}

/** Works out what kind of server lives at a URL and returns a connection for it. */
async function probeEndpoint(raw, { apiKey = '', fetchImpl = globalThis.fetch.bind(globalThis), local = false, timeoutMs = 6000 } = {}) {
  const url = new URL(raw);
  const origin = url.origin;
  const path = url.pathname.replace(/\/(chat\/completions|completions|models|messages|api\/tags|api\/chat|api\/generate)\/?$/, '').replace(/\/+$/, '');
  if (/anthropic\.com$/.test(url.hostname)) {
    const connection = makeConnection('anthropic', { apiKey });
    connection.models = rankModels(await listModels(connection, { fetchImpl, timeoutMs }));
    return connection;
  }
  const knownPreset = Object.entries(PRESETS).find(([, preset]) => preset.baseURL && preset.baseURL.startsWith(origin) && !/localhost/.test(preset.baseURL));
  const attempts = [];
  if (!path || path === '/v1') attempts.push({ kind: 'ollama', test: () => ollamaTags(origin, fetchImpl, timeoutMs) });
  const bases = [];
  if (path) bases.push(origin + path);
  if (!/\/v1$/.test(path)) bases.push(origin + path + '/v1');
  if (knownPreset) bases.unshift(knownPreset[1].baseURL);
  for (const base of [...new Set(bases)]) attempts.push({ kind: 'openai', base, test: () => listModels({ protocol: 'openai', baseURL: base, apiKey }, { fetchImpl, timeoutMs }) });
  let lastError = null;
  let authError = null;
  for (const attempt of attempts) {
    try {
      const ids = await attempt.test();
      if (attempt.kind === 'ollama') return makeConnection('ollama', { baseURL: origin + '/v1', local: true, models: rankModels(ids), label: local ? 'Ollama (this device)' : 'Ollama at ' + url.host });
      const provider = knownPreset ? knownPreset[0] : /:1234$/.test(origin) ? 'lmstudio' : /:8080$/.test(origin) ? 'llamacpp' : /:20128$/.test(origin) ? 'omniroute' : /:3001$/.test(origin) ? 'freellmapi' : 'custom';
      const label = knownPreset ? knownPreset[1].label : provider === 'custom' ? url.host : PRESETS[provider].label;
      // A gateway on localhost forwards to the cloud: time and label it as cloud.
      return makeConnection(provider, { baseURL: attempt.base, apiKey, local: local && !GATEWAYS.has(provider), models: orderByHints(rankModels(ids), ids.hints, { keyless: !apiKey }), skipModels: ids.hints ? [...ids.hints.noTools, ...(ids.hints.unavailable || []), ...(apiKey ? [] : ids.hints.paid)] : [], label });
    } catch (error) {
      // A gateway can guard an Ollama-style alias (/api/tags) as well as /v1, so an
      // auth failure on one probe must not stop the probes that carry the key.
      if (error instanceof ProviderError && (error.status === 401 || error.status === 403)) { authError = authError || error; continue; }
      lastError = error;
    }
  }
  if (authError) {
    throw new ProviderError(apiKey
      ? url.host + ' did not accept that key. Check it was copied whole and is allowed to list models.'
      : url.host + ' needs an API key. Paste the address and the key together, separated by a space: ' + url.origin + url.pathname.replace(/\/$/, '') + ' YOUR_KEY', { status: authError.status });
  }
  const reason = lastError instanceof TypeError || (lastError && lastError.name === 'AbortError')
    ? (local ? 'Nothing answered there. Is the server running, and does it allow browser apps? (Ollama: OLLAMA_ORIGINS=* ollama serve)' : 'Nothing answered there, or the server does not allow browser apps (CORS).')
    : 'It did not answer like a model server. ' + (lastError ? lastError.message : '');
  throw new ProviderError('Could not connect to ' + url.host + '. ' + reason);
}

/** Finds model servers already running on this device. Quiet: never throws. */
export async function scanLocal({ fetchImpl = globalThis.fetch.bind(globalThis), timeoutMs = 1200 } = {}) {
  const results = await Promise.all(LOCAL_SERVERS.map(async (server) => {
    try {
      if (server.provider === 'ollama') {
        const ids = await ollamaTags(server.origin, fetchImpl, timeoutMs);
        return makeConnection('ollama', { baseURL: server.origin + '/v1', local: true, models: rankModels(ids), label: 'Ollama (this device)' });
      }
      const ids = await listModels({ protocol: 'openai', baseURL: server.origin + '/v1' }, { fetchImpl, timeoutMs });
      return makeConnection(server.provider, { baseURL: server.origin + '/v1', local: true, models: rankModels(ids), label: server.provider === 'custom' ? 'Model server on localhost:8000' : PRESETS[server.provider].label });
    } catch {
      return null;
    }
  }));
  return results.filter((connection) => connection && connection.models.length);
}

/* ---------- Switching models when one runs out ---------- */

/**
 * Why a model call failed, in terms of what to do next:
 *   'auth'    the key is wrong: try another connection, not another model
 *   'credits' out of money or quota: try another model (free ones first)
 *   'rate'    rate limited: try another model
 *   'model'   the model is unknown, retired or cannot use tools: try another
 *   'context' the conversation is too long for this model: try a bigger one
 *   'network' cannot reach the server: try another connection
 *   'server'  provider-side failure: try another model
 *   'other'   do not switch
 */
export function classifyFailure(error) {
  if (!error) return 'other';
  if (error.name === 'AbortError') return 'other';
  if (error instanceof TypeError) return 'network';
  const status = Number(error.status || 0);
  const text = String(error.message || '').toLowerCase();
  if (/context length|context window|maximum context|too many tokens|prompt is too long|reduce the length/.test(text)) return 'context';
  if (status === 402 || /insufficient|credit|billing|payment|quota|exceeded your|balance/.test(text)) return 'credits';
  if (status === 401) return 'auth';
  if (status === 403) return /model|access|permission|not allowed|region/.test(text) && !/api key|invalid key|rejected the api key/.test(text.replace('the provider rejected the api key (403).', '')) ? 'model' : 'auth';
  if (status === 429 || /rate limit/.test(text)) return 'rate';
  if (status === 404 || /not found|does not exist|no endpoints|unknown model|model_not_found|decommissioned|deprecated|not supported|does not support tools|tool use|tool calling/.test(text)) return 'model';
  if (status >= 500) return 'server';
  if (status === 400 && /model|tool/.test(text)) return 'model';
  if (/could not reach|failed to fetch|network/.test(text)) return 'network';
  return 'other';
}

/**
 * The ordered list of models to try: the active one, then the rest of its
 * connection, then the best model of every other connection. Models that
 * failed recently are skipped for `cooldownMs`.
 */
export function buildChain(settings, { failed = {}, now = Date.now(), cooldownMs = 10 * 60 * 1000, limit = 8 } = {}) {
  const connections = settings.connections || [];
  const active = connections.find((connection) => connection.id === settings.activeConnection) || connections[0];
  if (!active) return [];
  const fresh = (connection, model) => !(failed[connection.id + '|' + model] && now - failed[connection.id + '|' + model] < cooldownMs);
  const chain = [];
  const push = (connection, model) => {
    if (model && !chain.some((entry) => entry.connection.id === connection.id && entry.model === model) && fresh(connection, model)) chain.push({ connection, model });
  };
  push(active, settings.activeModel || active.models[0]);
  if (settings.autoSwitch !== false) {
    for (const model of active.models.slice(0, 6)) push(active, model);
    for (const connection of connections) if (connection !== active) push(connection, connection.models[0]);
  }
  return chain.slice(0, limit);
}

/**
 * Picks the next model after `current` failed with `error`, or null. Credit
 * failures on OpenRouter jump to free models; auth and network failures skip
 * the rest of that connection.
 */
export function nextInChain(chain, current, error, { failed = {} } = {}) {
  const kind = classifyFailure(error);
  if (kind === 'other') return null;
  const index = chain.findIndex((entry) => entry.connection.id === current.connection.id && entry.model === current.model);
  let rest = chain.slice(index + 1);
  if (kind === 'auth' || kind === 'network') rest = rest.filter((entry) => entry.connection.id !== current.connection.id);
  if (kind === 'credits') {
    const free = rest.filter((entry) => /:free$/.test(entry.model) || entry.connection.local);
    const freeOnSame = current.connection.provider === 'openrouter'
      ? (current.connection.models || []).filter((model) => /:free$/.test(model) && model !== current.model).map((model) => ({ connection: current.connection, model }))
      : [];
    rest = [...freeOnSame, ...free, ...rest.filter((entry) => entry.connection.id !== current.connection.id)];
  }
  rest = rest.filter((entry) => !failed[entry.connection.id + '|' + entry.model]);
  return rest[0] ? { ...rest[0], kind } : null;
}

/** The provider config the agent's chat() expects, built from a chain entry. */
export function configFor(entry, extra = {}) {
  return { provider: entry.connection.provider, protocol: entry.connection.protocol, baseURL: entry.connection.baseURL, apiKey: entry.connection.apiKey, model: entry.model, connectionId: entry.connection.id, ...extra };
}
