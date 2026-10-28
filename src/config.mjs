import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const DEFAULT_BASE_URL = 'https://api.openai.com/v1';
export const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const DEFAULT_MODEL = 'gpt-6.1-sol';
export const DEFAULT_PROTOCOL = 'openai-responses';

const SETUP_PROVIDER_PRESETS = new Set([
  'omniroute', 'openai', 'anthropic', 'openrouter', 'gemini', 'ollama', 'custom'
]);

// A fresh setup should work for users who do not already have a paid-provider key.
export function resolveSetupProviderPreset(raw) {
  const candidate = String(raw || '').trim().toLowerCase();
  return SETUP_PROVIDER_PRESETS.has(candidate) ? candidate : 'omniroute';
}

export function isNodeVersionSupported(version = process.versions.node) {
  const match = String(version).match(/^(\d+)(?:\.|$)/);
  return Boolean(match && Number(match[1]) >= 22);
}

export function getConfigDirectory(env = process.env, home = os.homedir()) {
  if (env.OASIS_CONFIG_DIR) return path.resolve(env.OASIS_CONFIG_DIR);
  if (env.OASIS_HOME) return path.resolve(env.OASIS_HOME);
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'oasis');
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'oasis');
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
  if (!['openai-responses', 'openai-compatible', 'anthropic'].includes(protocol)) {
    throw new Error('Provider protocol must be openai-responses, openai-compatible, or anthropic.');
  }
  return protocol;
}

function stripTrailingSlashes(raw) {
  let value = String(raw || '');
  while (value.endsWith('/')) value = value.slice(0, -1);
  return value;
}

export function validateBaseUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('The provider URL must be a valid HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS provider URLs are supported.');
  if (url.protocol === 'http:' && !isLoopbackUrl(raw)) throw new Error('Non-local model providers must use HTTPS. HTTP is allowed only for localhost providers.');
  if (url.username || url.password || url.search || url.hash) throw new Error('Provider URLs must not include credentials, query parameters, or fragments.');
  return raw.replace(/\/+$/, '');
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
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
    if (error.code !== 'ENOENT') throw new Error('Could not read Oasis configuration: ' + error.message);
  }

  let savedBaseURL = '';
  try { savedBaseURL = validateBaseUrl(saved.baseURL || ''); } catch {}
  let savedProtocol;
  try { savedProtocol = validateProtocol(saved.protocol || inferProtocol(savedBaseURL, DEFAULT_PROTOCOL)); }
  catch { savedProtocol = inferProtocol(savedBaseURL, DEFAULT_PROTOCOL); }
  const requestedProtocol = env.OASIS_PROTOCOL || (env.OASIS_BASE_URL && stripTrailingSlashes(env.OASIS_BASE_URL) !== savedBaseURL ? inferProtocol(env.OASIS_BASE_URL, DEFAULT_PROTOCOL) : savedProtocol);
  const protocol = validateProtocol(requestedProtocol);
  const defaultBase = protocol === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL;
  const baseURL = validateBaseUrl(env.OASIS_BASE_URL || (savedProtocol === protocol ? savedBaseURL : '') || defaultBase);
  const defaultModel = protocol === 'anthropic' ? 'claude-sonnet-5' : (protocol === 'openai-responses' ? DEFAULT_MODEL : (savedProtocol === protocol ? saved.model : ''));
  const model = String(env.OASIS_MODEL || (savedProtocol === protocol ? saved.model : '') || defaultModel).trim();
  if (!model) throw new Error('No model is configured. Run oasis setup.');

  const sameSavedTarget = savedBaseURL === baseURL && savedProtocol === protocol;
  const localEndpoint = isLoopbackUrl(baseURL);
  const explicitKey = localEndpoint ? (env.OASIS_LOCAL_API_KEY || '') : (env.OASIS_API_KEY ||
    (protocol === 'anthropic' ? env.ANTHROPIC_API_KEY : env.OPENAI_API_KEY) || '');
  // Never send a stored/remote credential to a different endpoint or a loopback server by accident.
  const apiKey = explicitKey || (sameSavedTarget ? (saved.apiKey || '') : '');
  return {
    ...saved, protocol, baseURL, model, apiKey, configPath,
    configured: Boolean(apiKey) || isLoopbackUrl(baseURL),
    maxSteps: clampInteger(env.OASIS_MAX_STEPS || saved.maxSteps, 60, 1, 400),
    maxToolCalls: clampInteger(env.OASIS_MAX_TOOL_CALLS || saved.maxToolCalls, 300, 1, 2000),
    maxTokens: clampInteger(env.OASIS_MAX_TOKENS || saved.maxTokens, 2000000, 10000, 20000000),
    maxCommandSeconds: clampInteger(saved.maxCommandSeconds, 120, 5, 600)
  };
}

export async function saveConfig(config, options = {}) {
  const env = options.env || process.env;
  const configPath = options.configPath || getConfigPath(env);
  await mkdir(path.dirname(configPath), { recursive: true, mode: 0o700 });
  const protocol = validateProtocol(config.protocol || DEFAULT_PROTOCOL);
  const safe = {
    protocol,
    baseURL: validateBaseUrl(config.baseURL || (protocol === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_BASE_URL)),
    model: String(config.model || (protocol === 'anthropic' ? 'claude-sonnet-5' : (protocol === 'openai-responses' ? DEFAULT_MODEL : ''))).trim(),
    apiKey: String(config.apiKey || ''),
    maxSteps: clampInteger(config.maxSteps, 60, 1, 400),
    maxToolCalls: clampInteger(config.maxToolCalls, 300, 1, 2000),
    maxTokens: clampInteger(config.maxTokens, 2000000, 10000, 20000000),
    maxCommandSeconds: clampInteger(config.maxCommandSeconds, 120, 5, 600)
  };
  const contextWindow = Number.parseInt(config.contextWindow, 10);
  if (Number.isInteger(contextWindow) && contextWindow >= 4000 && contextWindow <= 2000000) safe.contextWindow = contextWindow;
  if (config.vision === false) safe.vision = false;
  if (config.promptCache === false) safe.promptCache = false;
  if (!safe.model) throw new Error('The model name cannot be empty.');
  await writeFile(configPath, JSON.stringify(safe, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
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
    authentication: config.apiKey ? 'API key configured' : (isLoopbackUrl(config.baseURL) ? 'local endpoint; no API key required' : 'not configured'),
    configPath: config.configPath || getConfigPath()
  };
}
