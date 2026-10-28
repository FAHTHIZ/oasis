// Approximate model pricing (USD per million tokens) used for /cost and
// --max-budget-usd. Override or extend with settings `pricing`:
//   { "pricing": { "my-model": { "input": 1, "output": 4, "cacheRead": 0.1 } } }
// or OASIS_PRICE_INPUT / OASIS_PRICE_OUTPUT (per million tokens) for the active model.
// Local models (Ollama, LM Studio, llama.cpp) cost nothing.

const TABLE = [
  [/claude-(opus-4-[5-9]|opus-[5-9])/i, { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }],
  [/claude-(3-)?opus/i, { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  [/claude.*sonnet/i, { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  [/claude.*haiku-4|claude-haiku-4/i, { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  [/claude.*haiku/i, { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
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
  [/gemini-2\.5-pro|gemini-3.*pro/i, { input: 1.25, output: 10, cacheRead: 0.31 }],
  [/gemini.*flash-lite/i, { input: 0.1, output: 0.4, cacheRead: 0.025 }],
  [/gemini.*flash/i, { input: 0.3, output: 2.5, cacheRead: 0.075 }],
  [/deepseek/i, { input: 0.28, output: 0.42, cacheRead: 0.028 }],
  [/qwen.*coder/i, { input: 0.3, output: 1.2 }],
  [/grok-code/i, { input: 0.2, output: 1.5 }],
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
  const price = priceFor(model, options);
  if (!price) return 0;
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
