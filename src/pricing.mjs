// Approximate model pricing (USD per million tokens) used for /cost and
// --max-budget-usd. Override or extend with settings `pricing`:
//   { "pricing": { "my-model": { "input": 1, "output": 4, "cacheRead": 0.1 } } }
// or OASIS_PRICE_INPUT / OASIS_PRICE_OUTPUT (per million tokens) for the active model.
// Local models (Ollama, LM Studio, llama.cpp) cost nothing.

// Sources (checked 2026-11): platform.claude.com/docs/en/about-claude/pricing and
// developers.openai.com/api/docs/pricing. Order matters: the first match wins.
// `long` is a per-request tier: a prompt (all input tokens, cached or not) over
// `threshold` tokens is billed at the long-context prices.
const OPENAI_LONG = (input, output, cacheRead) => ({ threshold: 272000, input, output, cacheRead });
const TABLE = [
  [/claude-(fable|mythos)-5-1/i, { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }],
  [/claude-(fable|mythos)/i, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }],
  [/claude-opus-5-5|claude-opus-5\.5/i, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
  [/claude-(opus-4-[5-9]|opus-[5-9])/i, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/claude-(3-)?opus/i, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  [/claude-sonnet-5-5|claude-sonnet-5\.5/i, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
  [/claude-sonnet-[5-9]/i, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }],
  [/claude.*sonnet/i, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/claude-haiku-5/i, { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125, long: { threshold: 100000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 } }],
  [/claude.*haiku-4|claude-haiku-4/i, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  [/claude.*haiku/i, { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  [/gpt-6(?:\.\d+)?-astra/i, { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, long: { threshold: 272000, input: 20, output: 75, cacheRead: 2, cacheWrite: 25 } }],
  [/gpt-6\.1-sol/i, { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5, long: { threshold: 272000, input: 4, output: 15, cacheRead: 0.2, cacheWrite: 5 } }],
  [/gpt-6\.1-terra/i, { input: 1, output: 5, cacheRead: 0.05, cacheWrite: 1.25 }],
  [/gpt-6(?:\.\d+)?-luna/i, { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }],
  [/gpt-6(?:-sol)?(?![\w.])/i, { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5, long: { threshold: 272000, input: 4, output: 15, cacheRead: 0.4, cacheWrite: 5 } }],
  [/gpt-5\.6-sol/i, { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5, long: { threshold: 272000, input: 8, output: 30, cacheRead: 0.8, cacheWrite: 10 } }],
  [/gpt-5\.6-terra/i, { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5, long: { threshold: 272000, input: 4, output: 18, cacheRead: 0.4, cacheWrite: 5 } }],
  [/gpt-5\.6-luna/i, { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 }],
  [/gpt-5\.5-pro/i, { input: 30, output: 180, long: { threshold: 272000, input: 60, output: 270 } }],
  [/gpt-5\.5(?![\w.])/i, { input: 5, output: 30, cacheRead: 0.5, long: OPENAI_LONG(10, 45, 1) }],
  [/gpt-5\.3-codex/i, { input: 1.75, output: 14, cacheRead: 0.175 }],
  [/gpt-5.*nano/i, { input: 0.05, output: 0.4, cacheRead: 0.005 }],
  [/gpt-5.*mini/i, { input: 0.25, output: 2, cacheRead: 0.025 }],
  [/gpt-5/i, { input: 1.25, output: 10, cacheRead: 0.125 }],
  [/gpt-4\.1-nano/i, { input: 0.1, output: 0.4, cacheRead: 0.025 }],
  [/gpt-4\.1-mini/i, { input: 0.4, output: 1.6, cacheRead: 0.1 }],
  [/gpt-4\.1/i, { input: 2, output: 8, cacheRead: 0.5 }],
  [/gpt-4o-mini/i, { input: 0.15, output: 0.6, cacheRead: 0.075 }],
  [/gpt-4o/i, { input: 2.5, output: 10, cacheRead: 1.25 }],
  [/\bo4-mini|\bo3-mini/i, { input: 1.1, output: 4.4, cacheRead: 0.275 }],
  [/\bo3\b/i, { input: 2, output: 8, cacheRead: 0.5 }],
  // Gemini (ai.google.dev/gemini-api/docs/pricing, standard paid tier). The 3.6/3.8
  // Flash rates are the 2026 launch prices; Google doubles them on 2027-01-01.
  [/gemini-3.*pro/i, { input: 2, output: 12, cacheRead: 0.2, long: { threshold: 200000, input: 4, output: 18, cacheRead: 0.4 } }],
  [/gemini-2\.5-pro/i, { input: 1.25, output: 10, cacheRead: 0.125, long: { threshold: 200000, input: 2.5, output: 15, cacheRead: 0.25 } }],
  [/gemini-3\.5-flash-lite/i, { input: 0.3, output: 2.5, cacheRead: 0.03 }],
  [/gemini-3(?:\.\d)?-flash-lite/i, { input: 0.25, output: 1.5, cacheRead: 0.025 }],
  [/gemini.*flash-lite/i, { input: 0.1, output: 0.4, cacheRead: 0.01 }],
  [/gemini-3\.[6-9]-flash/i, { input: 0.75, output: 3.75, cacheRead: 0.075 }],
  [/gemini-3(?:\.\d)?-flash/i, { input: 0.5, output: 3, cacheRead: 0.05 }],
  [/gemini.*flash/i, { input: 0.3, output: 2.5, cacheRead: 0.03 }],
  // DeepSeek V4 bills peak and off-peak hours; the peak rate is used so budgets stay safe.
  [/deepseek-v4-pro/i, { input: 1.32, output: 3.96, cacheRead: 0.044 }],
  [/deepseek-flash/i, { input: 0.3, output: 1.2, cacheRead: 0.006 }],
  [/deepseek/i, { input: 0.28, output: 0.42, cacheRead: 0.028 }],
  [/kimi-k3/i, { input: 3, output: 15, cacheRead: 0.3 }],
  [/^(?:[\w.-]+\/)?glm-5$/i, { input: 1, output: 3.2, cacheRead: 0.2 }],
  [/minimax-m3/i, { input: 0.3, output: 1.2, cacheRead: 0.06, long: { threshold: 512000, input: 0.6, output: 2.4, cacheRead: 0.12 } }],
  [/qwen.*coder/i, { input: 0.3, output: 1.2 }],
  [/grok-code/i, { input: 0.2, output: 1.5 }],
  // Grok 4.7 (docs.x.ai): prompts of 200K+ tokens bill every token at the higher rate.
  [/grok-4\.7/i, { input: 2, output: 6, cacheRead: 0.5, long: { threshold: 200000, input: 4, output: 12, cacheRead: 1 } }],
  [/grok/i, { input: 3, output: 15 }]
];

export function isLocalProvider(config = {}) {
  const base = String(config.baseURL || '');
  return config.protocol === 'ollama' || /\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(base);
}

export function priceFor(model, { config = {}, overrides = {}, env = process.env } = {}) {
  const name = String(model || '');
  if (env.OASIS_PRICE_INPUT || env.OASIS_PRICE_OUTPUT) {
    return { input: Number(env.OASIS_PRICE_INPUT) || 0, output: Number(env.OASIS_PRICE_OUTPUT) || 0, cacheRead: Number(env.OASIS_PRICE_CACHE_READ) || 0, cacheWrite: 0, custom: true };
  }
  if (isLocalProvider(config)) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, local: true };
  if (overrides && typeof overrides === 'object') {
    for (const [key, value] of Object.entries(overrides)) {
      if (value && typeof value === 'object' && name.toLowerCase().includes(key.toLowerCase())) {
        return { input: Number(value.input) || 0, output: Number(value.output) || 0, cacheRead: Number(value.cacheRead) || 0, cacheWrite: Number(value.cacheWrite) || 0, custom: true };
      }
    }
  }
  for (const [pattern, price] of TABLE) if (pattern.test(name)) return { cacheRead: 0, cacheWrite: 0, ...price };
  return null;
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
  const cost = (input * price.input + output * price.output + cacheRead * (price.cacheRead || price.input) + cacheWrite * (price.cacheWrite || price.input)) / 1e6;
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
