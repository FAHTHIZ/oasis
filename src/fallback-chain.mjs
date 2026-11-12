import { getProvider } from './provider-registry.mjs';
import { isOpen } from './circuit-breaker.mjs';

// Ranked fallback chain for the CLI.
//
// `--fallback-model` (or `fallbackModel` in settings) accepts one model or a
// comma-separated list. Each entry is either a model on the current provider
// (`gpt-6.1-mini`) or a model on another provider written `provider:model`
// (`openrouter:qwen/qwen3-coder`, `groq:moonshotai/kimi-k2-instruct`,
// `ollama:qwen3:4b`). Keys for other providers come from their usual
// environment variables; an entry whose key is missing is skipped.
// OASIS_FALLBACK_<PROVIDER>_BASE_URL points a provider at another address
// (an Ollama on another machine, a gateway).
//
// The chain is walked in order when the current model fails in a way another
// model can fix: out of credit, rate limited, overloaded, server errors,
// network failures, or the model is gone. Mistakes in the request itself
// (bad input, context overflow) and a bad key on the main provider are not
// retried elsewhere; they would fail on the next model too or need the user.

// Settings that describe one model or one endpoint, which must not leak into
// a fallback on a different provider.
const MODEL_SPECIFIC_KEYS = ['contextWindow', 'maxOutputTokens', 'thinkingBudget', 'vision', 'visionCapability', 'reasoningEffort', 'customHeaders', 'customHeadersHelper', 'betas', 'apiKeyHelper'];

export function parseFallbackChain(spec) {
  const items = Array.isArray(spec) ? spec : String(spec || '').split(',');
  const chain = [];
  const seen = new Set();
  for (const raw of items) {
    const text = String(raw || '').trim();
    if (!text) continue;
    const match = /^([a-z][a-z0-9_-]*):(.+)$/i.exec(text);
    const provider = match && getProvider(match[1]) ? match[1].toLowerCase() : '';
    const model = (provider ? match[2] : text).trim();
    if (!model) continue;
    const id = (provider ? provider + ':' : '') + model;
    if (seen.has(id)) continue;
    seen.add(id);
    chain.push({ id, provider, model });
  }
  return chain;
}

function firstKey(names, env) {
  for (const name of names) if (env[name]) return String(env[name]);
  return '';
}

// The config to use for one entry, or null when it cannot be used (no key).
export function resolveFallbackConfig(entry, baseConfig, env = process.env) {
  if (!entry || !baseConfig) return null;
  if (!entry.provider) return { ...baseConfig, model: entry.model };
  const preset = getProvider(entry.provider, { env });
  if (!preset) return null;
  const apiKey = preset.keyEnv.length ? firstKey(preset.keyEnv, env) : '';
  // Local servers (Ollama, vLLM) accept an optional key; hosted ones need one.
  if (preset.keyEnv.length && !apiKey && !preset.local) return null;
  const next = { ...baseConfig };
  for (const key of MODEL_SPECIFIC_KEYS) delete next[key];
  const baseURL = String(env['OASIS_FALLBACK_' + entry.provider.toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_BASE_URL'] || preset.baseURL).replace(/\/+$/, '');
  return { ...next, protocol: preset.protocol, baseURL, apiKey, model: entry.model, fallbackProvider: entry.provider };
}

const NETWORK_OR_STALL = /\b(429|500|502|503|504|529)\b|overload|rate.?limit|capacity|unavailable|bounded retries|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|fetch failed|stream stalled|timed out after \d+ seconds waiting/i;
const CREDITS = /insufficient[_ ](?:quota|credits?|balance|funds)|out of credits?|credit balance|billing|payment required|exceeded your current quota|quota exceeded|(?:not have|without) enough (?:remaining )?credits?|credit limit/i;
const MODEL_GONE = /model[^.]{0,60}(?:not found|does not exist|not available|unavailable|decommissioned|deprecated)|model_not_found|unknown model|no endpoints found|does not support tool/i;

// Why a failure should move to the next model, or '' when it should not.
// `onFallbackProvider` is true when the failing config is itself a fallback on
// another provider: a missing or bad key there just means "skip this one".
export function fallbackReason(error, { onFallbackProvider = false } = {}) {
  if (!error || error.name === 'AbortError') return '';
  const status = Number(error.status || error.statusCode) || 0;
  const text = String(error.message || error);
  if (/context.?length|context window|prompt is too long|too many tokens|maximum context/i.test(text) || status === 413) return '';
  // 402 first: credit messages often add "not an invalid API key" or "not an
  // authentication failure", which must not read as a bad key.
  if (status === 402) return 'credits';
  if (status === 401 || status === 403 || (/unauthori[sz]ed|invalid api key|incorrect api key|authentication/i.test(text) && !/\bnot an? (?:invalid )?api.?key|not an? (?:api.?key )?authentication/i.test(text))) return onFallbackProvider ? 'auth' : '';
  if (CREDITS.test(text)) return 'credits';
  if (status === 429 || /rate.?limit/i.test(text)) return 'rate';
  if (status === 404 || MODEL_GONE.test(text)) return 'model';
  if (status >= 500 || NETWORK_OR_STALL.test(text)) return 'server';
  // A stream that kept dropping after its restarts. A malformed tool call is
  // retried by the turn loop with a corrective note instead.
  if (error.code === 'OASIS_STREAM_INTERRUPTED' && !error.malformedCall) return 'server';
  return '';
}

export const FALLBACK_REASON_TEXT = Object.freeze({
  credits: 'ran out of credit',
  rate: 'hit a rate limit',
  model: 'is not available',
  server: 'is overloaded or unreachable',
  auth: 'rejected its API key'
});

// Exponential backoff with jitter for transient errors (429, 5xx, network
// failures) before giving up on the current model and moving to the next one
// in the fallback chain.
export function retryDelayMs(attempt, baseMs = 1000, maxMs = 30000, jitter = true) {
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, Number(attempt) || 0)));
  if (!jitter) return exponential;
  return Math.min(maxMs, Math.floor(exponential * (0.75 + Math.random() * 0.5)));
}

// Entries still worth trying after `failed` (a Set of ids), skipping the
// current model, any entry without a usable config, and any provider whose
// circuit breaker is open (cooling down after repeated failures).
export function remainingFallbacks(chain, { current, baseConfig, failed = new Set(), env = process.env } = {}) {
  const out = [];
  for (const entry of chain) {
    if (failed.has(entry.id)) continue;
    const config = resolveFallbackConfig(entry, baseConfig, env);
    if (!config) continue;
    if (current && config.model === current.model && config.baseURL === current.baseURL) continue;
    // Skip providers whose circuit breaker is open (cooling down).
    if (isOpen(config.fallbackProvider || 'default')) continue;
    out.push({ entry, config });
  }
  return out;
}

export function describeFallbackChain(chain, baseConfig, env = process.env) {
  return chain.map((entry) => {
    const usable = Boolean(resolveFallbackConfig(entry, baseConfig, env));
    const preset = entry.provider ? getProvider(entry.provider, { env }) : null;
    return { id: entry.id, model: entry.model, provider: entry.provider || 'current', usable, ...(preset && !usable ? { missing: preset.keyEnv.join(' or ') } : {}) };
  });
}
