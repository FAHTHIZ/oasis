import { atomicWriteFile } from './atomic-write.mjs';
import { BUILTIN_PROVIDERS, providerForEndpoint, providerApiKey } from './provider-registry.mjs';
import { DEFAULT_TURN_STEPS, MAX_TURN_STEPS, DEFAULT_TURN_TOOL_CALLS, MAX_TURN_TOOL_CALLS } from './model-budgets.mjs';
import { mkdir, readFile, chmod, copyFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { CLOUD_PROTOCOLS, cloudProtocolFromEnv, defaultCloudBaseURL, defaultCloudModel, cloudCredentialsPresent } from './cloud-providers.mjs';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_BASE_URL = BUILTIN_PROVIDERS.openai.baseURL;
export const DEFAULT_ANTHROPIC_BASE_URL = BUILTIN_PROVIDERS.anthropic.baseURL;
export const DEFAULT_MODEL = BUILTIN_PROVIDERS.openai.model;
export const DEFAULT_PROTOCOL = 'openai-responses';

const SETUP_PROVIDER_PRESETS = new Set([
  'openai', 'anthropic', 'openrouter', 'gemini', 'ollama', 'bedrock', 'vertex', 'foundry', 'custom'
]);

// A fresh setup should work for users who do not already have a paid-provider key.
// An explicit valid fallback lets callers choose a safe context-specific default.
// The key a registry provider on this loopback address reads from its own
// variable: FREELLMAPI_API_KEY for the FreeLLMAPI gateway on :3001. These
// names are specific to that server, so sending them there leaks nothing.
function localProviderKey(baseURL, env) {
  const id = providerForEndpoint(baseURL);
  return id ? providerApiKey(id, env) : '';
}

export function shouldPromptForProviderBaseURL(presetName) {
  return String(presetName || '').trim().toLowerCase() === 'custom';
}

export function resolveSetupProviderPreset(raw, fallback = 'openai') {
  const candidate = String(raw || '').trim().toLowerCase();
  if (SETUP_PROVIDER_PRESETS.has(candidate)) return candidate;
  const safeFallback = String(fallback || '').trim().toLowerCase();
  return SETUP_PROVIDER_PRESETS.has(safeFallback) ? safeFallback : 'openai';
}

// Preserve a provider the user already configured when they re-open interactive setup.
// Unknown endpoints intentionally map to "custom"; fresh installs start at the API-key choice.
export function inferSetupProviderPreset(config) {
  if (!config || config.configured !== true) return 'openai';
  let url;
  try { url = new URL(String(config.baseURL || '')); }
  catch { return 'custom'; }

  const protocol = String(config.protocol || '').trim().toLowerCase();
  // Setup offers these presets; any other registry provider shows as custom.
  const id = providerForEndpoint(url.href, protocol);
  if (['openai', 'anthropic', 'openrouter', 'gemini', 'ollama'].includes(id)) return id;
  return 'custom';
}

// The oldest Node.js the runtime dependencies support: the terminal renderer
// (@earendil-works/pi-tui) declares 22.19, OpenTelemetry 3 declares 22.15, and
// require() of ES modules (lowlight) needs 22.12. Keep in sync with
// package.json "engines"; test/dependency-engines.test.mjs checks both.
export const MIN_NODE_VERSION = '22.19.0';

export function isNodeVersionSupported(version = process.versions.node) {
  const match = String(version).match(/^(\d+)(?:\.(\d+)(?:\.(\d+))?)?(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) return false;
  const have = match.slice(1).map((part) => Number(part || 0));
  const need = MIN_NODE_VERSION.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i] > need[i];
  return true;
}

export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;

/** The base OASIS directory, ignoring profiles. */
export function getBaseConfigDirectory(env = process.env, home = os.homedir()) {
  if (env.OASIS_CONFIG_DIR) return path.resolve(env.OASIS_CONFIG_DIR);
  if (env.OASIS_HOME) return path.resolve(env.OASIS_HOME);
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'oasis');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'oasis');
}

/** Active profile name, or null for the default profile. Invalid names are rejected. */
export function activeProfile(env = process.env, home = os.homedir()) {
  let name = String(env.OASIS_PROFILE || '').trim();
  // `oasis profile use NAME` stores a sticky default; OASIS_PROFILE and --profile override it.
  if (!name && !env.OASIS_CONFIG_DIR && env.OASIS_PROFILE === undefined) {
    try { name = readFileSync(path.join(getBaseConfigDirectory(env, home), 'active-profile'), 'utf8').trim(); } catch { name = ''; }
    if (name && !PROFILE_NAME_PATTERN.test(name)) name = '';
  }
  if (!name || name === 'default') return null;
  if (!PROFILE_NAME_PATTERN.test(name)) throw new Error('Invalid OASIS profile name "' + name + '": use letters, digits, - and _ (up to 40).');
  return name;
}

// A profile (OASIS_PROFILE / --profile NAME) is a separate agent: its own config,
// keys, settings, memories, sessions, skills, commands, MCP servers and cron jobs,
// under <base>/profiles/NAME. An explicit OASIS_CONFIG_DIR always wins.
export function getConfigDirectory(env = process.env, home = os.homedir()) {
  const base = getBaseConfigDirectory(env, home);
  if (env.OASIS_CONFIG_DIR) return base;
  const profile = activeProfile(env, home);
  return profile ? path.join(base, 'profiles', profile) : base;
}

export function getConfigPath(env = process.env, home = os.homedir()) {
  return path.join(getConfigDirectory(env, home), 'config.json');
}

export function isLoopbackUrl(raw) {
  try {
    const url = new URL(raw);
    return ['localhost', '127.0.0.1', '::1', '[::1]'].includes(url.hostname.toLowerCase());
  } catch { return false; }
}

export function inferProtocol(baseURL, fallback = DEFAULT_PROTOCOL) {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    if (host === 'api.anthropic.com' || host.endsWith('.anthropic.com')) return 'anthropic';
    if (host === 'api.openai.com') return 'openai-responses';
    return fallback === 'openai-responses' ? 'openai-compatible' : fallback;
  } catch { return fallback; }
}

export function validateProtocol(raw) {
  const protocol = String(raw || DEFAULT_PROTOCOL).trim().toLowerCase();
  if (!['openai-responses', 'openai-compatible', 'anthropic', 'bedrock', 'vertex', 'foundry'].includes(protocol)) {
    throw new Error('Provider protocol must be openai-responses, openai-compatible, anthropic, bedrock, vertex, or foundry.');
  }
  return protocol;
}

function stripTrailingSlashes(raw) {
  let value = String(raw || '');
  while (value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

export function validateBaseUrl(raw) {
  const input = String(raw || '').trim();
  let url;
  try {
    url = new URL(input);
  } catch {
    const looksLikeModelId = /^[A-Za-z0-9][A-Za-z0-9._/-]{1,199}$/.test(input) && !/^[a-z][a-z0-9+.-]*:/i.test(input);
    if (looksLikeModelId) {
      throw new Error('That looks like a model ID, not a provider URL. Keep the provider URL default and enter model IDs such as "gemini-3.8-flash" at the Model name prompt. Custom provider URLs must start with https:// (or http:// for localhost).');
    }
    throw new Error('The provider URL must be a valid HTTP or HTTPS URL beginning with https:// (or http:// for localhost).');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS provider URLs are supported.');
  if (url.protocol === 'http:' && !isLoopbackUrl(input)) throw new Error('Non-local model providers must use HTTPS. HTTP is allowed only for localhost providers.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Provider URLs must not include credentials, query parameters, or fragments.');
  return input.replace(/\/+$/, '');
}

function strictInteger(value) {
  const raw = typeof value === 'number' ? value : String(value ?? '').trim();
  if (typeof raw === 'string' && !/^[+-]?\d+$/.test(raw)) return null;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function clampInteger(value, fallback, min, max) {
  const parsed = strictInteger(value);
  if (parsed === null) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

export async function loadConfig(options = {}) {
  const env = options.env || process.env;
  const configPath = options.configPath || getConfigPath(env);
  let saved = {};
  try {
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) saved = parsed;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read Oasis configuration: ' + error.message + ' (' + configPath + '). Fix the file, or run oasis setup to replace it; setup keeps a copy of the unreadable file.');
  }

  let savedBaseURL = '';
  try { savedBaseURL = validateBaseUrl(saved.baseURL || ''); } catch {}
  let savedProtocol;
  try { savedProtocol = validateProtocol(saved.protocol || inferProtocol(savedBaseURL, DEFAULT_PROTOCOL)); }
  catch { savedProtocol = inferProtocol(savedBaseURL, DEFAULT_PROTOCOL); }
  // OPENAI_BASE_URL / ANTHROPIC_BASE_URL (the vendor SDK and Claude Code convention) are used
  // only when nothing OASIS-specific is set and nothing is saved, so a variable exported for
  // another tool never overrides `oasis setup`. Without this, OPENAI_API_KEY went to api.openai.com.
  const vendorBase = !env.OASIS_BASE_URL && !env.OASIS_PROTOCOL && !cloudProtocolFromEnv(env) && !savedBaseURL && !saved.protocol
    ? (env.OPENAI_BASE_URL ? { name: 'OPENAI_BASE_URL', url: String(env.OPENAI_BASE_URL), protocol: inferProtocol(String(env.OPENAI_BASE_URL), DEFAULT_PROTOCOL) }
      : env.ANTHROPIC_BASE_URL ? { name: 'ANTHROPIC_BASE_URL', url: String(env.ANTHROPIC_BASE_URL), protocol: 'anthropic' } : null)
    : null;
  const envBase = env.OASIS_BASE_URL ? { name: 'OASIS_BASE_URL', url: String(env.OASIS_BASE_URL) } : vendorBase;
  const requestedProtocol = env.OASIS_PROTOCOL || cloudProtocolFromEnv(env) || vendorBase?.protocol || (env.OASIS_BASE_URL && stripTrailingSlashes(env.OASIS_BASE_URL) !== savedBaseURL ? inferProtocol(env.OASIS_BASE_URL, DEFAULT_PROTOCOL) : savedProtocol);
  const protocol = validateProtocol(requestedProtocol);
  const cloud = CLOUD_PROTOCOLS.includes(protocol);
  const defaultBase = cloud ? defaultCloudBaseURL(protocol, env) : (protocol === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL);
  const chosenBase = envBase?.url || (savedProtocol === protocol ? savedBaseURL : '') || defaultBase;
  if (!chosenBase && protocol === 'foundry') throw new Error('Microsoft Foundry needs a resource: set ANTHROPIC_FOUNDRY_RESOURCE to your Azure resource name, or ANTHROPIC_FOUNDRY_BASE_URL to https://RESOURCE.services.ai.azure.com/anthropic.');
  const baseURL = validateBaseUrl(chosenBase);
  const defaultModel = cloud ? defaultCloudModel(protocol, env) : protocol === 'anthropic' ? 'claude-sonnet-5' : (protocol === 'openai-responses' ? DEFAULT_MODEL : (savedProtocol === protocol ? saved.model : ''));
  const model = String(env.OASIS_MODEL || (savedProtocol === protocol ? saved.model : '') || defaultModel).trim();
  if (!model) throw new Error(cloud ? 'No model is configured for ' + protocol + '. Set OASIS_MODEL (or ANTHROPIC_MODEL) to a ' + (protocol === 'bedrock' ? 'Bedrock model or inference profile ID, for example us.anthropic.claude-sonnet-5-5' : protocol === 'foundry' ? 'Foundry deployment name (or ANTHROPIC_DEFAULT_SONNET_MODEL), for example claude-sonnet-5-5' : 'Vertex model ID, for example claude-sonnet-5-5') + '.' : envBase ? 'No model is configured for ' + envBase.name + ' (' + stripTrailingSlashes(envBase.url) + '). Set OASIS_MODEL to a model that server lists, or run oasis connect ' + stripTrailingSlashes(envBase.url) + ' to pick one and save it.' : 'No model is configured. Run oasis setup.');

  const sameSavedTarget = savedBaseURL === baseURL && savedProtocol === protocol;
  const localEndpoint = isLoopbackUrl(baseURL);
  const explicitKey = cloud ? (protocol === 'bedrock' ? env.AWS_BEARER_TOKEN_BEDROCK || '' : protocol === 'foundry' ? env.ANTHROPIC_FOUNDRY_API_KEY || '' : '') : localEndpoint ? (env.OASIS_LOCAL_API_KEY || (env.OASIS_BASE_URL && env.OASIS_API_KEY ? env.OASIS_API_KEY : '') || localProviderKey(baseURL, env)) : (env.OASIS_API_KEY ||
    (protocol === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) || '');
  // Never send a stored/remote credential to a different endpoint or a loopback server by accident.
  // A local gateway that needs a key (LiteLLM, OmniRoute with auth) gets OASIS_LOCAL_API_KEY, or
  // OASIS_API_KEY when OASIS_BASE_URL names the server in the same environment; an ambient
  // OPENAI_API_KEY / ANTHROPIC_API_KEY is never sent to a local server. A registry provider on
  // that address reads its own variable (FREELLMAPI_API_KEY, OMNIROUTE_API_KEY, VLLM_API_KEY).
  const apiKey = explicitKey || (sameSavedTarget ? (saved.apiKey || '') : '');
  // apiKeyHelper (settings or OASIS_API_KEY_HELPER) supplies the key at request time when none is set.
  const apiKeyHelper = !apiKey && !cloud && !localEndpoint && env.OASIS_API_KEY_HELPER ? String(env.OASIS_API_KEY_HELPER) : '';
  const normalizedSaved = { ...saved };
  for (const [key, min, max] of [
    ['contextWindow', 4000, 2000000],
    ['thinkingBudget', 1024, 64000],
    ['maxOutputTokens', 1024, 128000]
  ]) {
    if (!Object.hasOwn(saved, key)) continue;
    const value = strictInteger(saved[key]);
    if (value === null || value < min || value > max) delete normalizedSaved[key];
    else normalizedSaved[key] = value;
  }
  return {
    ...normalizedSaved, protocol, baseURL, model, apiKey, configPath, ...(apiKeyHelper ? { apiKeyHelper } : {}),
    configured: Boolean(apiKey) || Boolean(apiKeyHelper) || isLoopbackUrl(baseURL) || (cloud && cloudCredentialsPresent(protocol, env)) || (sameSavedTarget && saved.keyless === true),
    maxSteps: clampInteger(env.OASIS_MAX_STEPS || saved.maxSteps, DEFAULT_TURN_STEPS, 1, MAX_TURN_STEPS),
    maxToolCalls: clampInteger(env.OASIS_MAX_TOOL_CALLS || saved.maxToolCalls, DEFAULT_TURN_TOOL_CALLS, 1, MAX_TURN_TOOL_CALLS),
    maxTokens: clampInteger(env.OASIS_MAX_TOKENS || saved.maxTokens, 2000000, 10000, 20000000),
    maxCommandSeconds: clampInteger(saved.maxCommandSeconds, 120, 5, 600)
  };
}

const PROVIDER_IDENTITY_KEYS = new Set(['protocol', 'baseURL', 'model', 'apiKey']);
// Computed by loadConfig or taken from the environment; never written back.
const RUNTIME_CONFIG_KEYS = new Set(['configPath', 'configured', 'apiKeyHelper']);
const ENDPOINT_CONFIG_KEYS = new Set(['customHeaders', 'customHeadersHelper', 'betas', 'fallbackModel', 'keyless']);
const MODEL_CONFIG_KEYS = new Set(['contextWindow', 'maxOutputTokens', 'thinkingBudget', 'vision', 'visionCapability', 'replayReasoning']);
// saveConfig validates these itself and drops invalid values rather than copying them.
const VALIDATED_CONFIG_KEYS = new Set(['maxSteps', 'maxToolCalls', 'maxTokens', 'maxCommandSeconds', 'contextWindow', 'vision', 'promptCache', 'readDedup', 'maxQuestionsPerTurn', 'leanTools', 'followups', 'secretShield', 'parallelToolCalls', 'thinkingBudget', 'requireReadBeforeEdit', 'maxOutputTokens', 'reasoningEffort']);

export async function saveConfig(config, options = {}) {
  const env = options.env || process.env;
  const configPath = options.configPath || getConfigPath(env);
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  // Merge with what is already saved so a provider change (setup, auth login,
  // connecting from chat or the web UI) does not erase your other settings:
  // preferences always carry over, gateway headers and betas only for the same
  // endpoint, and model limits (context window, output cap) only for the same model.
  let existing = {};
  let backupPath = '';
  let raw = null;
  try { raw = await readFile(configPath, 'utf8'); } catch {}
  if (raw !== null && raw.trim()) {
    let parsed;
    try { parsed = JSON.parse(raw); } catch { parsed = undefined; }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (options.preserve !== false) existing = parsed;
    } else {
      // An unreadable file (often a hand edit with a typo) would otherwise be
      // replaced and its other settings lost: keep a copy next to it first.
      backupPath = configPath + '.invalid-' + new Date().toISOString().replace(/[:.]/g, '-');
      try { await copyFile(configPath, backupPath); await chmod(backupPath, 0o600).catch(() => {}); } catch { backupPath = ''; }
      if (typeof options.onInvalidConfig === 'function') options.onInvalidConfig({ configPath, backupPath });
      else process.emitWarning('The OASIS configuration at ' + configPath + ' was not valid JSON' + (backupPath ? '; a copy was saved to ' + backupPath : '') + ' before it was replaced.', { code: 'OASIS_CONFIG_INVALID' });
    }
  }
  const defined = Object.fromEntries(Object.entries(config || {}).filter(([key, value]) => value !== undefined && !RUNTIME_CONFIG_KEYS.has(key)));
  const nextProtocol = validateProtocol(defined.protocol || DEFAULT_PROTOCOL);
  let nextBase = '';
  try { nextBase = validateBaseUrl(defined.baseURL || ''); } catch {}
  const sameEndpoint = existing.protocol === nextProtocol && stripTrailingSlashes(String(existing.baseURL || '')) === stripTrailingSlashes(nextBase);
  const sameModel = sameEndpoint && String(existing.model || '').trim() === String(defined.model || '').trim();
  const carried = {};
  for (const [key, value] of Object.entries(existing)) {
    if (PROVIDER_IDENTITY_KEYS.has(key) || RUNTIME_CONFIG_KEYS.has(key)) continue;
    if (ENDPOINT_CONFIG_KEYS.has(key) && !sameEndpoint) continue;
    if (MODEL_CONFIG_KEYS.has(key) && !sameModel) continue;
    carried[key] = value;
  }
  config = { ...carried, ...defined };
  const protocol = validateProtocol(config.protocol || DEFAULT_PROTOCOL);
  const safe = {
    protocol,
    baseURL: validateBaseUrl(config.baseURL || (CLOUD_PROTOCOLS.includes(protocol) ? defaultCloudBaseURL(protocol, env) : protocol === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL)),
    model: String(config.model || (protocol === 'anthropic' ? 'claude-sonnet-5' : (protocol === 'openai-responses' ? DEFAULT_MODEL : ''))).trim(),
    apiKey: String(config.apiKey || ''),
    maxSteps: clampInteger(config.maxSteps, DEFAULT_TURN_STEPS, 1, MAX_TURN_STEPS),
    maxToolCalls: clampInteger(config.maxToolCalls, DEFAULT_TURN_TOOL_CALLS, 1, MAX_TURN_TOOL_CALLS),
    maxTokens: clampInteger(config.maxTokens, 2000000, 10000, 20000000),
    maxCommandSeconds: clampInteger(config.maxCommandSeconds, 120, 5, 600)
  };
  const contextWindow = strictInteger(config.contextWindow);
  if (contextWindow !== null && contextWindow >= 4000 && contextWindow <= 2000000) safe.contextWindow = contextWindow;
  if (config.vision === false) safe.vision = false;
  if (config.promptCache === false) safe.promptCache = false;
  if (config.readDedup === false) safe.readDedup = false;
  if ((Number.isInteger(config.maxQuestionsPerTurn) && config.maxQuestionsPerTurn >= 0 && config.maxQuestionsPerTurn <= 50) || config.maxQuestionsPerTurn === 'off') safe.maxQuestionsPerTurn = config.maxQuestionsPerTurn;
  if (config.leanTools === false) safe.leanTools = false;
  if (config.followups === false) safe.followups = false;
  if (config.secretShield === false) safe.secretShield = false;
  if (config.parallelToolCalls === false) safe.parallelToolCalls = false;
  const thinkingBudget = strictInteger(config.thinkingBudget);
  if (thinkingBudget !== null && thinkingBudget >= 1024 && thinkingBudget <= 64000) safe.thinkingBudget = thinkingBudget;
  if (config.requireReadBeforeEdit === false || config.requireReadBeforeEdit === 'strict') safe.requireReadBeforeEdit = config.requireReadBeforeEdit;
  const maxOutputTokens = strictInteger(config.maxOutputTokens);
  if (maxOutputTokens !== null && maxOutputTokens >= 1024 && maxOutputTokens <= 128000) safe.maxOutputTokens = maxOutputTokens;
  if (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(config.reasoningEffort || '').toLowerCase())) safe.reasoningEffort = String(config.reasoningEffort).toLowerCase();
  if (!safe.model) throw new Error('The model name cannot be empty.');
  // Keys validated where they are used (customHeaders, temperature, betas,
  // autoCompactPercent, ...) are kept as plain JSON values.
  for (const [key, value] of Object.entries(config)) {
    if (Object.hasOwn(safe, key) || VALIDATED_CONFIG_KEYS.has(key) || PROVIDER_IDENTITY_KEYS.has(key) || RUNTIME_CONFIG_KEYS.has(key)) continue;
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value) || (typeof value === 'object' && !(value instanceof Date))) {
      try { safe[key] = JSON.parse(JSON.stringify(value)); } catch {}
    }
  }
  // Atomic so a crash or full disk mid-save can't leave a truncated config.
  await atomicWriteFile(configPath, JSON.stringify(safe, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  try { await chmod(configPath, 0o600); } catch { /* POSIX mode bits are unavailable on some filesystems. */ }
  return configPath;
}

export function getProviderSummary(config) {
  let host = 'provider not configured';
  try { host = new URL(config.baseURL).host; } catch {}
  return {
    provider: host,
    protocol: config.protocol || DEFAULT_PROTOCOL,
    model: config.model || DEFAULT_MODEL,
    authentication: config.protocol === 'bedrock' ? (config.apiKey ? 'Bedrock API key' : 'AWS credentials (SigV4)') : config.protocol === 'vertex' ? 'Google Cloud access token' : config.protocol === 'foundry' ? (process.env.ANTHROPIC_FOUNDRY_AUTH_TOKEN ? 'Microsoft Entra ID token' : config.apiKey ? 'Foundry API key' : 'Microsoft Entra ID (az login)') : config.apiKey ? 'API key configured' : (isLoopbackUrl(config.baseURL) ? 'local endpoint; no API key required' : 'not configured'),
    configPath: config.configPath || getConfigPath()
  };
}

// The session learns the real context window from the local server, the
// provider's model list, or an overflow error. Reloading config each turn must
// not forget it while the provider and model are unchanged, or compaction
// thresholds snap back to the model default and a small local window overflows.
export function carryLearnedContextWindow(previous, next) {
  if (!previous || !next || next.contextWindow) return next;
  const learned = Number(previous.contextWindow) || 0;
  if (!learned) return next;
  const same = previous.protocol === next.protocol && String(previous.baseURL || '') === String(next.baseURL || '') && previous.model === next.model;
  return same ? { ...next, contextWindow: learned } : next;
}
