// Token usage: normalize provider-reported counts across protocols, and
// estimate them when a gateway reports none.
import { countTextTokens } from './tokens.mjs';

// Some OpenAI-compatible gateways never report usage, even with include_usage.
// Estimate from characters (about 4 per token) so spend tracking and
// --max-budget-usd still work; the estimate is marked so it is never mistaken
// for provider-reported counts.
export function usageOrEstimate(rawUsage, requestText, message = {}) {
  const usage = normalizeUsage(rawUsage || {});
  // A usage object with any token field is the provider's own report, even if zero.
  const reported = rawUsage && typeof rawUsage === 'object' && ['prompt_tokens', 'completion_tokens', 'total_tokens', 'input_tokens', 'output_tokens'].some((key) => rawUsage[key] !== undefined && rawUsage[key] !== null);
  if (reported || usage.totalTokens > 0) return usage;
  let outputTokens = typeof message.content === 'string' ? countTextTokens(message.content) : 0;
  for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) outputTokens += countTextTokens(String(call && call.function && call.function.arguments || '')) + countTextTokens(String(call && call.function && call.function.name || ''));
  const inputTokens = countTextTokens(String(requestText || ''));
  if (!inputTokens && !outputTokens) return usage;
  return { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens, estimated: true };
}

export function normalizeUsage(usage = {}) {
  const baseInput = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0;
  const cacheTokens = usage.cache_creation_input_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const inputTokens = usage.input_tokens !== undefined ? baseInput + cacheTokens + cacheRead : baseInput;
  const outputTokens = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0;
  const cachedOpenAI = Number(usage.prompt_tokens_details && usage.prompt_tokens_details.cached_tokens || usage.input_tokens_details && usage.input_tokens_details.cached_tokens || 0) || 0;
  // OpenAI (GPT-5.6+) reports cache writes in input_tokens_details.cache_write_tokens,
  // split into 30-minute and 12-hour writes; cached_tokens excludes them.
  const details = usage.input_tokens_details || usage.prompt_tokens_details || {};
  const openaiWrites = Number(details.cache_write_tokens || 0) || 0;
  const openaiLongWrites = Number(details.cache_write_tokens_details && details.cache_write_tokens_details.ttl_12h_tokens || 0) || 0;
  const out = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  if (cacheRead || cachedOpenAI) out.cacheReadTokens = Number(cacheRead || cachedOpenAI);
  if (cacheTokens || openaiWrites) out.cacheCreationTokens = Number(cacheTokens || openaiWrites);
  if (!cacheTokens && openaiLongWrites) out.cacheWriteLongTokens = Math.min(openaiLongWrites, openaiWrites || openaiLongWrites);
  return out;
}
