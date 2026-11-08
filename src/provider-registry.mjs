// The one table of model providers the runtime knows by name.
//
// Setup, the configure_provider tool, `--fallback-model provider:model`,
// local-server discovery and setup-preset inference all read this table, so a
// provider is added, renamed or re-pointed in one place. (The browser app in
// app/core keeps its own catalogue because it runs without Node.js.)
//
// Users extend or override it without editing code:
//   settings.json  "providers": { "acme": { "protocol": "openai-compatible",
//                    "baseURL": "https://llm.acme.internal/v1", "keyEnv": ["ACME_KEY"],
//                    "model": "acme-coder" } }
//   environment    OASIS_PROVIDER_<ID>_BASE_URL / OASIS_PROVIDER_<ID>_MODEL
//                  (OASIS_FALLBACK_<ID>_BASE_URL is still read for fallbacks)
//
// protocol is one of the adapters in agent.mjs: openai-responses,
// openai-compatible, anthropic (bedrock/vertex/foundry are configured through
// cloud-providers.mjs). keyEnv lists environment variables tried in order.
// catalog is the provider's id in the models.dev catalog (model-catalog.mjs),
// used to look up context and output limits and prices for its models; a
// custom gateway that serves another provider's models can name that id.

// This module imports nothing from the rest of OASIS: config.mjs derives
// DEFAULT_MODEL and the default base URLs from it.

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

const BUILTIN = {
  openai: { label: 'OpenAI', catalog: 'openai', protocol: 'openai-responses', baseURL: 'https://api.openai.com/v1', keyEnv: ['OPENAI_API_KEY'], model: 'gpt-6.1-sol' },
  anthropic: { label: 'Anthropic', catalog: 'anthropic', protocol: 'anthropic', baseURL: 'https://api.anthropic.com', keyEnv: ['ANTHROPIC_API_KEY'], model: 'claude-sonnet-5' },
  openrouter: { label: 'OpenRouter', catalog: 'openrouter', protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', keyEnv: ['OPENROUTER_API_KEY'], model: '' },
  gemini: { label: 'Google Gemini', catalog: 'google', protocol: 'openai-compatible', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], model: 'gemini-3.8-flash' },
  groq: { label: 'Groq', catalog: 'groq', protocol: 'openai-compatible', baseURL: 'https://api.groq.com/openai/v1', keyEnv: ['GROQ_API_KEY'], model: '' },
  deepseek: { label: 'DeepSeek', catalog: 'deepseek', protocol: 'openai-compatible', baseURL: 'https://api.deepseek.com/v1', keyEnv: ['DEEPSEEK_API_KEY'], model: '' },
  mistral: { label: 'Mistral', catalog: 'mistral', protocol: 'openai-compatible', baseURL: 'https://api.mistral.ai/v1', keyEnv: ['MISTRAL_API_KEY'], model: '' },
  xai: { label: 'xAI', catalog: 'xai', protocol: 'openai-compatible', baseURL: 'https://api.x.ai/v1', keyEnv: ['XAI_API_KEY'], model: '' },
  moonshot: { label: 'Moonshot (Kimi)', catalog: 'moonshotai', protocol: 'openai-compatible', baseURL: 'https://api.moonshot.ai/v1', keyEnv: ['MOONSHOT_API_KEY'], model: '' },
  huggingface: { label: 'Hugging Face', catalog: 'huggingface', protocol: 'openai-compatible', baseURL: 'https://router.huggingface.co/v1', keyEnv: ['HF_TOKEN', 'HUGGINGFACE_API_KEY'], model: '' },
  together: { label: 'Together AI', catalog: 'togetherai', protocol: 'openai-compatible', baseURL: 'https://api.together.xyz/v1', keyEnv: ['TOGETHER_API_KEY'], model: '' },
  fireworks: { label: 'Fireworks AI', catalog: 'fireworks-ai', protocol: 'openai-compatible', baseURL: 'https://api.fireworks.ai/inference/v1', keyEnv: ['FIREWORKS_API_KEY'], model: '' },
  cerebras: { label: 'Cerebras', catalog: 'cerebras', protocol: 'openai-compatible', baseURL: 'https://api.cerebras.ai/v1', keyEnv: ['CEREBRAS_API_KEY'], model: '' },
  nvidia: { label: 'NVIDIA NIM', catalog: 'nvidia', protocol: 'openai-compatible', baseURL: 'https://integrate.api.nvidia.com/v1', keyEnv: ['NVIDIA_API_KEY'], model: '' },
  ollama: { label: 'Ollama', protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', keyEnv: ['OLLAMA_API_KEY'], model: '', local: { probe: '/api/tags', kind: 'ollama' } },
  lmstudio: { label: 'LM Studio', protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:1234/v1', keyEnv: [], model: '', local: { probe: '/v1/models', kind: 'openai' } },
  llamacpp: { label: 'llama.cpp server', protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:8080/v1', keyEnv: [], model: '', local: { probe: '/v1/models', kind: 'openai' } },
  jan: { label: 'Jan', protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:1337/v1', keyEnv: [], model: '', local: { probe: '/v1/models', kind: 'openai' } },
  // OmniRoute is a self-hosted gateway on loopback that forwards to cloud
  // providers, so `gateway` keeps it from being priced or tuned as a local model.
  omniroute: { label: 'OmniRoute', protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:20128/v1', keyEnv: ['OMNIROUTE_API_KEY'], model: 'auto', gateway: true },
  vllm: { label: 'vLLM', protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:8000/v1', keyEnv: ['VLLM_API_KEY'], model: '', local: { probe: '/v1/models', kind: 'openai' } }
};

const PROTOCOLS = new Set(['openai-responses', 'openai-compatible', 'anthropic']);
const ID_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

function freezeEntry(id, entry) {
  return Object.freeze({ id, ...entry, keyEnv: Object.freeze([...(entry.keyEnv || [])]), ...(entry.local ? { local: Object.freeze({ ...entry.local }) } : {}) });
}

/** Built-in providers, frozen. Prefer providerRegistry() so user overrides apply. */
export const BUILTIN_PROVIDERS = Object.freeze(Object.fromEntries(Object.entries(BUILTIN).map(([id, entry]) => [id, freezeEntry(id, entry)])));

let activeUserProviders = {};
/** Record the user-scope settings.providers (settings.mjs calls this after loading). */
export function useProviderSettings(providers) {
  activeUserProviders = providers && typeof providers === 'object' && !Array.isArray(providers) ? { ...providers } : {};
}

function envName(id) { return id.toUpperCase().replace(/[^A-Z0-9]/g, '_'); }

function userEntry(id, raw, base) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const protocol = raw.protocol === undefined ? base && base.protocol : String(raw.protocol);
  if (!PROTOCOLS.has(protocol)) return null;
  const baseURL = raw.baseURL === undefined ? base && base.baseURL : String(raw.baseURL);
  try { const url = new URL(baseURL); if (!/^https?:$/.test(url.protocol)) return null; } catch { return null; }
  const keyEnv = raw.keyEnv === undefined ? (base ? base.keyEnv : []) : (Array.isArray(raw.keyEnv) ? raw.keyEnv : [raw.keyEnv]).map(String).filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name));
  return {
    label: raw.label ? String(raw.label).slice(0, 60) : (base ? base.label : id),
    protocol,
    baseURL,
    keyEnv,
    model: raw.model === undefined ? (base ? base.model : '') : String(raw.model).slice(0, 200),
    ...(raw.catalog !== undefined ? (/^[a-z0-9][a-z0-9.-]{0,59}$/.test(String(raw.catalog)) ? { catalog: String(raw.catalog) } : {}) : (base && base.catalog ? { catalog: base.catalog } : {})),
    ...(base && base.local ? { local: base.local } : {}),
    ...((raw.gateway !== undefined ? raw.gateway === true : base && base.gateway) ? { gateway: true } : {}),
    custom: true
  };
}

/**
 * Built-in providers merged with settings.providers and OASIS_PROVIDER_<ID>_*
 * environment overrides. Invalid user entries are ignored rather than thrown,
 * so a typo in settings cannot break startup.
 * @returns {Readonly<Record<string, Readonly<{ id: string, label: string, protocol: string, baseURL: string, keyEnv: readonly string[], model: string, local?: object, custom?: boolean }>>>}
 */
export function providerRegistry({ settings, env = process.env } = {}) {
  const merged = { ...BUILTIN };
  const source = settings === undefined ? { providers: activeUserProviders } : settings;
  const extra = source && typeof source.providers === 'object' && !Array.isArray(source.providers) ? source.providers : {};
  for (const [rawId, raw] of Object.entries(extra)) {
    const id = String(rawId).toLowerCase();
    if (!ID_PATTERN.test(id)) continue;
    const entry = userEntry(id, raw, merged[id]);
    if (entry) merged[id] = entry;
  }
  for (const id of Object.keys(merged)) {
    const name = envName(id);
    const baseURL = env['OASIS_PROVIDER_' + name + '_BASE_URL'];
    const model = env['OASIS_PROVIDER_' + name + '_MODEL'];
    if (baseURL || model) merged[id] = { ...merged[id], ...(baseURL ? { baseURL: String(baseURL) } : {}), ...(model ? { model: String(model) } : {}) };
  }
  return Object.freeze(Object.fromEntries(Object.entries(merged).map(([id, entry]) => [id, freezeEntry(id, entry)])));
}

/** One provider by id (case-insensitive), or null. */
export function getProvider(id, options) {
  const key = String(id || '').trim().toLowerCase();
  const registry = providerRegistry(options);
  return Object.hasOwn(registry, key) ? registry[key] : null;
}

/** The first non-empty key among the provider's keyEnv variables, or ''. */
export function providerApiKey(provider, env = process.env) {
  const entry = typeof provider === 'string' ? getProvider(provider, { env }) : provider;
  if (!entry) return '';
  for (const name of entry.keyEnv) if (env[name]) return String(env[name]);
  return '';
}

function sameEndpoint(a, b) {
  try {
    const x = new URL(String(a)), y = new URL(String(b));
    const host = (u) => (LOCAL_HOSTS.has(u.hostname.toLowerCase()) ? 'localhost' : u.hostname.toLowerCase());
    const port = (u) => u.port || (u.protocol === 'https:' ? '443' : '80');
    return host(x) === host(y) && port(x) === port(y);
  } catch { return false; }
}

/**
 * The registry id whose endpoint matches baseURL (host and port; loopback
 * names are equivalent) and, when given, protocol. '' when none does.
 */
export function providerForEndpoint(baseURL, protocol, options) {
  const registry = providerRegistry(options);
  for (const entry of Object.values(registry)) {
    if (protocol && entry.protocol !== protocol) continue;
    if (sameEndpoint(entry.baseURL, baseURL)) return entry.id;
  }
  return '';
}


/** Compare two base URLs ignoring a trailing slash. */
export function sameBaseURL(a, b) {
  return String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
}
