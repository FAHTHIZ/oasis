// Zero-budget mode and request/token budgets, checked before a request is sent.
//
// Zero-budget mode (`--zero-budget`, OASIS_ZERO_BUDGET=1, or settings
// `"zeroBudget": true`) only sends a request to a route with positive evidence
// that it cannot bill: a model server on this machine, a keyless public
// endpoint, an OpenRouter `:free` variant, or a model you declared free.
// A route whose cost is unknown is refused like a paid one. This follows
// OmniRoute's STRICT_ZERO_COST rule (unknown is never treated as safe), without
// its catalog or database.
//
// Request and token budgets (`--max-requests`, `--max-total-tokens`) count every
// HTTP attempt, retries included, across the parent and its in-process
// subagents (the shared budgetLedger), and stop before the attempt that would
// exceed them.

import { priceFor, isLocalProvider, cloudModelBehindGateway } from './pricing.mjs';
import { isOpenRouterBaseURL } from './model-budgets.mjs';

const ON = /^(?:1|true|yes|on)$/i;

// Default ports of model servers that run the model themselves: Ollama,
// LM Studio, llama.cpp, vLLM, KoboldCpp, Jan. A loopback service on another
// port may be a gateway (LiteLLM, OmniRoute) forwarding to a paid provider.
const LOCAL_SERVER_PORTS = new Set(['11434', '1234', '8080', '8000', '5001', '1337']);

export function zeroBudgetEnabled(session = {}, env = process.env) {
  if (env && env.OASIS_ZERO_BUDGET !== undefined && env.OASIS_ZERO_BUDGET !== '') return ON.test(String(env.OASIS_ZERO_BUDGET));
  return Boolean(session && (session.zeroBudget === true || (session.config && session.config.zeroBudget === true)));
}

function globToRegExp(pattern) {
  return new RegExp('^' + pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$', 'i');
}

/** Models you declared free (OASIS_FREE_MODELS or settings `freeModels`), `*` wildcards allowed. */
export function declaredFreeModels(session = {}, env = process.env) {
  const fromEnv = String(env && env.OASIS_FREE_MODELS || '').split(',');
  const fromSettings = Array.isArray(session && session.freeModels) ? session.freeModels : [];
  return [...fromEnv, ...fromSettings].map((item) => String(item || '').trim()).filter(Boolean);
}

function loopbackPort(config) {
  try {
    const url = new URL(String(config.baseURL || ''));
    return url.port || (url.protocol === 'https:' ? '443' : '80');
  } catch { return ''; }
}

/**
 * What a request to `config` can cost, and the evidence.
 * Returns { cost: 'free' | 'paid' | 'unknown', reason }.
 */
export function routeCost(config = {}, { session = {}, env = process.env } = {}) {
  const model = String(config.model || '');
  const declared = declaredFreeModels(session, env);
  const qualified = (config.fallbackProvider ? config.fallbackProvider + ':' : '') + model;
  if (declared.some((pattern) => globToRegExp(pattern).test(model) || globToRegExp(pattern).test(qualified))) return { cost: 'free', reason: 'you declared it free' };
  if (isLocalProvider(config) && !cloudModelBehindGateway(model, config)) {
    if (config.protocol === 'ollama' || LOCAL_SERVER_PORTS.has(loopbackPort(config))) return { cost: 'free', reason: 'a model server on this machine' };
    return { cost: 'unknown', reason: 'a local endpoint on port ' + loopbackPort(config) + ', which may be a gateway that forwards to a paid provider' };
  }
  const price = priceFor(model, { config, overrides: session.pricing || {}, env });
  if (price && price.keyless) return { cost: 'free', reason: 'a keyless public endpoint' };
  if (isOpenRouterBaseURL(config.baseURL) && (/:free$/i.test(model) || /^openrouter\/free$/i.test(model))) return { cost: 'free', reason: 'an OpenRouter free variant' };
  if (price && price.custom && !(price.input > 0) && !(price.output > 0)) return { cost: 'free', reason: 'you priced it at $0' };
  if (price && (price.input > 0 || price.output > 0 || price.cacheRead > 0)) return { cost: 'paid', reason: 'listed at $' + price.input + ' / $' + price.output + ' per million input/output tokens' };
  if (price) return { cost: 'unknown', reason: 'the catalog lists it at $0, but a free tier can still bill once it is used up' };
  return { cost: 'unknown', reason: 'no price is known for it' };
}

export class ZeroBudgetError extends Error {
  constructor(config, verdict) {
    const name = (config.fallbackProvider ? config.fallbackProvider + ':' : '') + (config.model || 'this model');
    super('Zero-budget mode refused ' + name + ' before sending anything: its cost is ' + verdict.cost + ' (' + verdict.reason + '). Use a local model or an OpenRouter :free model, or, if you know this route cannot bill you, add it to OASIS_FREE_MODELS or settings "freeModels".');
    this.code = 'OASIS_ZERO_BUDGET_BLOCKED';
    this.model = name;
    this.cost = verdict.cost;
  }
}

/** Throws ZeroBudgetError when zero-budget mode is on and `config` is not proven free. */
export function assertZeroBudgetRoute(session, config, env = process.env) {
  if (!zeroBudgetEnabled(session, env)) return null;
  const verdict = routeCost(config, { session, env });
  if (verdict.cost !== 'free') throw new ZeroBudgetError(config, verdict);
  return verdict;
}

function positiveInteger(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isSafeInteger(number) && number > 0) return number;
  }
  return 0;
}

export function requestBudgetLimits(session = {}, env = process.env) {
  return {
    maxRequests: positiveInteger(session.maxRequests, env && env.OASIS_MAX_REQUESTS),
    maxTotalTokens: positiveInteger(session.maxTotalTokens, env && env.OASIS_MAX_TOTAL_TOKENS)
  };
}

export class RequestBudgetError extends Error {
  constructor(kind, used, limit, extra = '') {
    super(kind === 'requests'
      ? 'Stopped before model request ' + (used + 1) + ': the --max-requests limit of ' + limit + ' is used up. The conversation so far is saved; resume it with a higher limit.'
      : 'Stopped before a model request: ' + used + ' tokens used' + extra + ' would pass the --max-total-tokens limit of ' + limit + '. The conversation so far is saved; resume it with a higher limit.');
    this.code = kind === 'requests' ? 'REQUEST_BUDGET_EXCEEDED' : 'TOKEN_BUDGET_EXCEEDED';
    this.used = used;
    this.limit = limit;
  }
}

function ledgerOf(session) {
  const ledger = session.budgetLedger && typeof session.budgetLedger === 'object'
    ? session.budgetLedger
    : (session.budgetLedger = { spentUsd: Math.max(0, Number(session.costUsd) || 0), unknownRequests: 0 });
  if (!Number.isSafeInteger(ledger.requests) || ledger.requests < 0) ledger.requests = 0;
  if (!Number.isSafeInteger(ledger.tokens) || ledger.tokens < 0) ledger.tokens = 0;
  return ledger;
}

/**
 * Called before every HTTP attempt. Counts it, or throws RequestBudgetError
 * when it would pass a limit. `estimatedInputTokens` is the request body's
 * rough size, so a prompt that alone would pass the token budget is not sent.
 */
export function chargeRequestAttempt(session, { estimatedInputTokens = 0, env = process.env } = {}) {
  if (!session || typeof session !== 'object') return;
  const { maxRequests, maxTotalTokens } = requestBudgetLimits(session, env);
  const ledger = ledgerOf(session);
  if (maxRequests && ledger.requests >= maxRequests) throw new RequestBudgetError('requests', ledger.requests, maxRequests);
  const estimate = Math.max(0, Math.ceil(Number(estimatedInputTokens) || 0));
  if (maxTotalTokens && ledger.tokens + estimate > maxTotalTokens) throw new RequestBudgetError('tokens', ledger.tokens, maxTotalTokens, ' plus about ' + estimate + ' for this prompt');
  ledger.requests += 1;
}

/** Records the tokens a reply actually used (input + output). */
export function recordTokenUsage(session, usage = {}) {
  if (!session || typeof session !== 'object' || !usage) return 0;
  const ledger = ledgerOf(session);
  const total = Number(usage.totalTokens) || (Number(usage.inputTokens) || 0) + (Number(usage.outputTokens) || 0);
  ledger.tokens += Math.max(0, Math.round(total));
  return ledger.tokens;
}

export function isBudgetStop(error) {
  return Boolean(error && (error.code === 'REQUEST_BUDGET_EXCEEDED' || error.code === 'TOKEN_BUDGET_EXCEEDED' || error.code === 'OASIS_ZERO_BUDGET_BLOCKED'));
}
