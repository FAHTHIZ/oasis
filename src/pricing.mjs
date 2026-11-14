import { catalogPrice } from './model-catalog.mjs';
import { LOCAL_MODEL_SERVER_PORTS, GATEWAY_PORTS } from './provider-registry.mjs';

// Approximate model pricing (USD per million tokens) used for /cost and
// --max-budget-usd. Override or extend with settings `pricing`:
//   { "pricing": { "my-model": { "input": 1, "output": 4, "cacheRead": 0.1 } } }
// or OASIS_PRICE_INPUT / OASIS_PRICE_OUTPUT (per million tokens) for the active model.
// Local models (Ollama, LM Studio, llama.cpp) cost nothing.

// Prices come from the models.dev catalog (src/model-catalog.mjs). A catalog
// context tier becomes `long`: a prompt (all input tokens, cached or not) over
// `threshold` tokens is billed at the long-context prices.
export function isLocalProvider(config = {}) {
  const base = String(config.baseURL || '');
  return config.protocol === 'ollama' || /\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(base);
}

// A loopback URL is usually a local model (Ollama, LM Studio, llama-server),
// but a gateway such as LiteLLM on localhost:4000 forwards to paid cloud
// models. A cloud-only model name on a non-local-server port is priced as the
// cloud model instead of shown as free.
const CLOUD_ONLY_MODEL = /^(?:[\w.-]+\/)?(?:gpt-|o[1-9](?:-|$)|claude|gemini-|grok-)/i;
// On a gateway's default port (OmniRoute 20128, FreeLLMAPI 3001) every model
// is a routed cloud model, whatever its name (llm7/codestral-latest), so it is
// never priced as free.
export function cloudModelBehindGateway(model, config = {}) {
  if (config.protocol === 'ollama') return false;
  try { if (GATEWAY_PORTS.has(new URL(String(config.baseURL || '')).port)) return true; } catch { /* not a URL */ }
  if (!CLOUD_ONLY_MODEL.test(String(model || ''))) return false;
  try {
    const url = new URL(String(config.baseURL || ''));
    return !LOCAL_MODEL_SERVER_PORTS.has(url.port);
  } catch { return false; }
}

// A remote endpoint saved as keyless and called with no key, key helper or
// auth header cannot bill anyone (a free public endpoint). The footer used to
// say "cost unknown" for it. Local gateways that hold keys are loopback and
// keep their own rule above.
function keylessRemote(config = {}) {
  if (!config || config.keyless !== true || config.apiKey || config.apiKeyHelper || isLocalProvider(config)) return false;
  const headers = config.customHeaders && typeof config.customHeaders === 'object' ? Object.keys(config.customHeaders) : [];
  return !headers.some((key) => /^(?:authorization|x-api-key|api-key|proxy-authorization)$/i.test(key));
}

export function priceFor(model, { config = {}, overrides = {}, env = process.env } = {}) {
  const name = String(model || '');
  if (env.OASIS_PRICE_INPUT || env.OASIS_PRICE_OUTPUT) {
    return { input: Number(env.OASIS_PRICE_INPUT) || 0, output: Number(env.OASIS_PRICE_OUTPUT) || 0, cacheRead: Number(env.OASIS_PRICE_CACHE_READ) || 0, cacheWrite: 0, custom: true };
  }
  if (isLocalProvider(config) && !cloudModelBehindGateway(name, config)) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, local: true };
  if (keylessRemote(config)) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, keyless: true };
  if (overrides && typeof overrides === 'object') {
    for (const [key, value] of Object.entries(overrides)) {
      if (value && typeof value === 'object' && name.toLowerCase().includes(key.toLowerCase())) {
        return { input: Number(value.input) || 0, output: Number(value.output) || 0, cacheRead: Number(value.cacheRead) || 0, cacheWrite: Number(value.cacheWrite) || 0, custom: true };
      }
    }
  }
  return catalogPrice(name, { baseURL: config.baseURL, provider: config.catalogProvider, env });
}

// Estimates the cost of one request's usage. Returns 0 for unknown models.
export function estimateCostUsd(model, usage = {}, options = {}) {
  let price = priceFor(model, options);
  if (!price) return 0;
  // Long prompts move the whole request to the long-context tier.
  if (price.long && Number(usage.inputTokens || 0) > price.long.threshold) price = { ...price, ...price.long };
  // Claude fast mode (speed: "fast") bills Opus 5.5, Opus 5 and Opus 4.8 at 2x the
  // base rates across the whole window; cache multipliers stack on top.
  if (usage.speed === 'fast' && !price.custom && !price.local && /opus-(?:5(?:[-.]5)?(?![-.]?\d)|4[-.]8)/i.test(String(model || ''))) {
    price = { ...price, input: price.input * 2, output: price.output * 2, cacheRead: (price.cacheRead || price.input) * 2, cacheWrite: (price.cacheWrite || price.input) * 2 };
  }
  const cacheRead = Number(usage.cacheReadTokens || 0);
  const cacheWrite = Number(usage.cacheCreationTokens || 0);
  const input = Math.max(0, Number(usage.inputTokens || 0) - cacheRead - cacheWrite);
  const output = Number(usage.outputTokens || 0);
  // OpenAI 12-hour cache writes bill at 2.5x input instead of the 30-minute 1.25x.
  const longWrite = Math.min(cacheWrite, Number(usage.cacheWriteLongTokens || 0));
  const longWriteRate = price.cacheWriteLong || price.input * 2.5;
  const cost = (input * price.input + output * price.output + cacheRead * (price.cacheRead || price.input) + (cacheWrite - longWrite) * (price.cacheWrite || price.input) + longWrite * longWriteRate) / 1e6;
  return Number.isFinite(cost) ? cost : 0;
}

export function formatUsd(value) {
  const amount = Number(value) || 0;
  if (amount === 0) return '$0.00';
  if (amount < 0.01) return '$' + amount.toFixed(4);
  return '$' + amount.toFixed(2);
}

export class BudgetExceededError extends Error {
  constructor(spent, limit) {
    super('Stopped: the estimated cost ' + formatUsd(spent) + ' reached the --max-budget-usd limit of ' + formatUsd(limit) + '.');
    this.code = 'BUDGET_EXCEEDED';
    this.spent = spent;
    this.limit = limit;
  }
}

/** Record estimated spend locally and against a shared parent/child budget ledger. */
export function recordBudgetSpend(session, amount, options = {}) {
  if (!session || typeof session !== 'object') throw new TypeError('A session is required to record model spend.');
  const delta = Math.max(0, Number(amount) || 0);
  const local = Math.max(0, Number(session.costUsd) || 0);
  session.costUsd = local + delta;
  const ledger = session.budgetLedger && typeof session.budgetLedger === 'object'
    ? session.budgetLedger
    : (session.budgetLedger = { spentUsd: local, unknownRequests: 0 });
  ledger.spentUsd = Math.max(0, Number(ledger.spentUsd) || 0) + delta;
  if (!Number.isSafeInteger(ledger.unknownRequests) || ledger.unknownRequests < 0) ledger.unknownRequests = 0;
  if (options.costKnown === false) ledger.unknownRequests += 1;
  const limit = Math.max(0, Number(session.maxBudgetUsd) || 0);
  if (options.enforce !== false && limit > 0 && ledger.spentUsd >= limit) throw new BudgetExceededError(ledger.spentUsd, limit);
  return ledger.spentUsd;
}
