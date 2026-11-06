// Model limits and prices from the models.dev catalog (https://models.dev, MIT,
// github.com/sst/models.dev), the community-maintained database that opencode and
// other harnesses read. A trimmed snapshot ships in src/data/model-catalog.json
// (regenerate with `node scripts/update-model-catalog.mjs`), so lookups work
// offline and on first run. Interactive sessions refresh a per-user copy at most
// once a day in the background; OASIS_MODEL_CATALOG_REFRESH=0 or
// DISABLE_NONESSENTIAL_TRAFFIC turns that off, and OASIS_MODEL_CATALOG points
// at a custom catalog file (full models.dev api.json or the trimmed form).

import fs from 'node:fs';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

export const MODEL_CATALOG_URL = 'https://models.dev/api.json';
const SNAPSHOT = new URL('./data/model-catalog.json', import.meta.url);
const REFRESH_MS = 24 * 60 * 60 * 1000;

// Providers whose catalog entry has no `api` base URL, keyed by API host.
const HOST_PROVIDERS = {
  'api.anthropic.com': 'anthropic',
  'api.openai.com': 'openai',
  'generativelanguage.googleapis.com': 'google',
  'api.x.ai': 'xai',
  'api.groq.com': 'groq',
  'api.mistral.ai': 'mistral',
  'api.together.xyz': 'togetherai',
  'api.cerebras.ai': 'cerebras',
  'api.deepinfra.com': 'deepinfra',
  'api.perplexity.ai': 'perplexity',
  'api.cohere.com': 'cohere',
  'api.moonshot.cn': 'moonshotai-cn',
  'open.bigmodel.cn': 'zhipuai'
};
// Without a provider hint, a bare id resolves at the model maker first.
const FIRST_PARTY = ['anthropic', 'openai', 'google', 'xai', 'deepseek', 'moonshotai', 'zai', 'minimax', 'mistral', 'alibaba', 'cohere', 'perplexity', 'xiaomi', 'stepfun', 'openrouter'];

// Keep only the fields Oasis reads: context/input/output limits, prices, and
// whether the model accepts image input.
export function trimCatalog(raw, providers) {
  const out = {};
  for (const [id, provider] of Object.entries(raw || {})) {
    if (providers && !providers.includes(id)) continue;
    if (!provider || typeof provider !== 'object' || !provider.models) continue;
    const models = {};
    for (const [modelId, model] of Object.entries(provider.models)) {
      const limit = (model && model.limit) || {};
      const cost = (model && model.cost) || {};
      const entry = {};
      if (positive(limit.context)) entry.context = limit.context;
      if (positive(limit.input)) entry.input = limit.input;
      if (positive(limit.output)) entry.output = limit.output;
      const inputs = model && model.modalities && model.modalities.input;
      if (Array.isArray(inputs)) entry.image = inputs.includes('image');
      const price = pickPrices(cost);
      if (price) {
        const tiers = (Array.isArray(cost.tiers) ? cost.tiers : [])
          .filter((tier) => tier && tier.tier && tier.tier.type === 'context' && positive(tier.tier.size))
          .map((tier) => ({ ...pickPrices(tier), size: tier.tier.size }))
          .sort((a, b) => a.size - b.size);
        if (tiers.length) price.tiers = tiers;
        entry.cost = price;
      }
      if (Object.keys(entry).length) models[modelId] = entry;
    }
    out[id] = { ...(provider.api ? { api: provider.api } : {}), models };
  }
  return out;
}

function pickPrices(cost) {
  const out = {};
  for (const key of ['input', 'output', 'cache_read', 'cache_write']) {
    if (typeof cost[key] === 'number' && Number.isFinite(cost[key]) && cost[key] >= 0) out[key] = cost[key];
  }
  return 'input' in out || 'output' in out ? out : null;
}

function positive(value) { return typeof value === 'number' && Number.isFinite(value) && value > 0; }

export function catalogCachePath(env = process.env) {
  return path.join(getConfigDirectory(env), 'cache', 'model-catalog.json');
}

function readCatalogFile(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.providers && typeof data.providers === 'object') return data;
    // A full models.dev api.json document.
    if (data && typeof data === 'object' && !Array.isArray(data)) return { fetchedAt: null, providers: trimCatalog(data) };
  } catch {}
  return null;
}

let loaded = null;
let loadedKey = '';

export function loadModelCatalog(env = process.env) {
  const custom = env && env.OASIS_MODEL_CATALOG;
  let cacheFile = '';
  try { cacheFile = catalogCachePath(env); } catch {}
  const key = custom ? 'custom:' + custom : 'cache:' + cacheFile;
  if (loaded && loadedKey === key) return loaded;
  let catalog = custom ? readCatalogFile(custom) : null;
  if (!catalog) {
    const snapshot = readCatalogFile(SNAPSHOT) || { fetchedAt: null, providers: {} };
    const cached = cacheFile ? readCatalogFile(cacheFile) : null;
    catalog = cached && Date.parse(cached.fetchedAt || 0) > Date.parse(snapshot.fetchedAt || 0) ? cached : snapshot;
  }
  loaded = index(catalog);
  loadedKey = key;
  return loaded;
}

export function resetModelCatalogForTest() { loaded = null; loadedKey = ''; }

function index(catalog) {
  const providers = catalog.providers || {};
  const hosts = new Map(Object.entries(HOST_PROVIDERS));
  for (const [id, provider] of Object.entries(providers)) {
    const host = hostOf(provider.api);
    if (host && !hosts.has(host)) hosts.set(host, id);
  }
  const order = [...FIRST_PARTY.filter((id) => providers[id]), ...Object.keys(providers).filter((id) => !FIRST_PARTY.includes(id))];
  // Lower-cased ids so "MiniMax-M3" and "minimax-m3" both resolve.
  // Router ids ("qwen/qwen3-coder") and Bedrock ids
  // ("global.anthropic.claude-sonnet-4-20250514-v1:0") are also reachable by their bare name.
  const lower = {};
  const bare = {};
  for (const id of order) {
    const map = new Map();
    const short = new Map();
    for (const [modelId, model] of Object.entries(providers[id].models || {})) {
      const key = modelId.toLowerCase();
      map.set(key, { id: modelId, ...model });
      for (const tail of bareNames(key)) {
        // Bedrock's global profile carries the base price; regional ones add a premium.
        if (tail !== key && (!short.has(tail) || key.startsWith('global.'))) short.set(tail, { id: modelId, ...model });
      }
    }
    lower[id] = map;
    bare[id] = short;
  }
  return { fetchedAt: catalog.fetchedAt || null, providers, hosts, order, lower, bare };
}

function bareNames(key) {
  const tail = key.slice(key.lastIndexOf('/') + 1);
  const bedrock = tail.replace(/^(?:(?:us|eu|apac|global|jp|au|ca|us-gov)\.)?[a-z0-9-]+\.(?=[a-z])/, '').replace(/-v\d+(?::\d+)?$/, '');
  return bedrock === tail ? [tail] : [tail, bedrock];
}

function hostOf(url) {
  try { return new URL(String(url)).hostname.toLowerCase(); } catch { return ''; }
}

export function providerForBaseURL(baseURL, env = process.env) {
  const host = hostOf(baseURL);
  if (!host) return null;
  const { hosts } = loadModelCatalog(env);
  if (hosts.has(host)) return hosts.get(host);
  for (const [known, id] of hosts) if (host.endsWith('.' + known)) return id;
  if (host.endsWith('.openai.azure.com')) return 'azure';
  if (/^bedrock-runtime\./.test(host)) return 'amazon-bedrock';
  if (/aiplatform\.googleapis\.com$/.test(host)) return 'google-vertex';
  return null;
}

// Candidate spellings of a model id, most specific first: the id itself, without
// a router prefix ("anthropic/claude-x"), without a date or version suffix, and
// with dotted versions written with dashes (and back).
function candidates(model) {
  const out = [];
  const add = (value) => { if (value && !out.includes(value)) out.push(value); };
  const base = String(model || '').trim().toLowerCase();
  const forms = [base];
  if (base.includes('/')) forms.push(base.slice(base.lastIndexOf('/') + 1));
  for (const form of forms) {
    add(form);
    const undated = form.replace(/(?:[-@](?:\d{8}|\d{4}-\d{2}-\d{2})|-v\d+(?::\d+)?|:latest)$/, '');
    add(undated);
    for (const value of [form, undated]) {
      add(value.replace(/(\d)\.(\d)/g, '$1-$2'));
      add(value.replace(/(\d)-(\d)(?!\d{2,})/g, '$1.$2'));
    }
  }
  return out;
}

export function findCatalogModel(model, { baseURL, provider, env = process.env } = {}) {
  if (!model) return null;
  const catalog = loadModelCatalog(env);
  const hint = provider && catalog.lower[provider] ? provider : providerForBaseURL(baseURL, env);
  const names = candidates(model);
  const search = (providers) => {
    for (const table of [catalog.lower, catalog.bare]) {
      for (const name of names) {
        for (const id of providers) {
          const entry = table[id] && table[id].get(name);
          if (entry) return { provider: id, ...entry };
        }
      }
    }
    return null;
  };
  // The configured provider's own listing wins; otherwise model makers come first.
  return (hint && search([hint])) || search(catalog.order);
}

// The context window Oasis plans for. When a model bills prompts above some size
// at a higher rate (models.dev context tiers), the window stops at that size so
// automatic compaction keeps requests on the base price. Set contextWindow to use
// the full advertised window.
export function catalogContextWindow(model, options = {}) {
  const entry = findCatalogModel(model, options);
  if (!entry) return null;
  let window = entry.context || 0;
  if (entry.input && (!window || entry.input < window)) window = entry.input;
  const cost = entry.cost;
  if (cost && Array.isArray(cost.tiers)) {
    for (const tier of cost.tiers) {
      if (tier.size < window && (tier.input || 0) > (cost.input || 0)) { window = tier.size; break; }
    }
  }
  return window > 0 ? window : null;
}

// Whether the catalog lists image input for the model: true, false, or null when
// the model or its modalities are not in the catalog.
export function catalogImageInput(model, options = {}) {
  const entry = findCatalogModel(model, options);
  return entry && typeof entry.image === 'boolean' ? entry.image : null;
}

// USD per million tokens in Oasis's pricing shape, with the first context tier as
// the per-request long-context rate.
export function catalogPrice(model, options = {}) {
  const entry = findCatalogModel(model, options);
  if (!entry || !entry.cost) return null;
  const price = toPrice(entry.cost);
  const tier = (entry.cost.tiers || [])[0];
  if (tier) price.long = { threshold: tier.size, ...toPrice(tier) };
  return price;
}

function toPrice(cost) {
  return { input: cost.input || 0, output: cost.output || 0, cacheRead: cost.cache_read || 0, cacheWrite: cost.cache_write || 0 };
}

export function catalogRefreshDisabled(env = process.env) {
  const off = (value) => /^(?:0|false|off|no)$/i.test(String(value || ''));
  const on = (value) => value !== undefined && value !== '' && !off(value);
  return off(env.OASIS_MODEL_CATALOG_REFRESH) || on(env.DISABLE_NONESSENTIAL_TRAFFIC) || on(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC) ||
    on(env.OASIS_OFFLINE) || on(env.CI) || Boolean(env.OASIS_MODEL_CATALOG) || Boolean(env.NODE_TEST_CONTEXT);
}

// Download models.dev into the user cache when the cached copy is over a day old.
// Never throws; resolves to true when a new catalog was written.
export async function refreshModelCatalog({ env = process.env, fetchImpl = globalThis.fetch, force = false, now = Date.now() } = {}) {
  if (!force && catalogRefreshDisabled(env)) return false;
  if (typeof fetchImpl !== 'function') return false;
  let file;
  try { file = catalogCachePath(env); } catch { return false; }
  try {
    if (!force && now - fs.statSync(file).mtimeMs < REFRESH_MS) return false;
  } catch {}
  try {
    const response = await fetchImpl(MODEL_CATALOG_URL, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
    if (!response.ok) return false;
    const providers = trimCatalog(await response.json());
    if (Object.keys(providers).length < 5) return false;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(temp, JSON.stringify({ source: MODEL_CATALOG_URL, fetchedAt: new Date(now).toISOString(), providers }));
    fs.renameSync(temp, file);
    resetModelCatalogForTest();
    return true;
  } catch {
    return false;
  }
}
