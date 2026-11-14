// Browser-safe (no Node imports): shared by the CLI (model-budgets.mjs) and
// the browser app (app/core/providers.mjs).

/** Parse the real maximum out of a provider "max_tokens too large" error, if any. */
export function outputCapFromError(status, body) {
  if (status !== 400) return 0;
  const text = String(body || '');
  if (!/max_tokens|max_output_tokens|max_completion_tokens|maximum (allowed )?(number of )?output tokens/i.test(text)) return 0;
  const explicit = text.match(/>\s*(\d{3,6})\b/) || text.match(/(?:maximum|max|up to|at most|limit(?: is)?)[^\d]{0,60}(\d{3,6})/i);
  const parsed = explicit ? Number.parseInt(explicit[1], 10) : 0;
  return parsed >= 1024 ? parsed : 8192;
}

// Default output limit for an Anthropic model when none is configured.
// Claude 3 models allow 4,096 output tokens, 3.5 allows 8,192, and Claude
// 3.7 / 4 and later at least 32,000 (the ceiling Claude Code also uses).
export function anthropicDefaultOutputTokens(model) {
  const name = String(model || '');
  if (/claude-(instant|2)|claude-3-(opus|sonnet|haiku)/i.test(name)) return 4096;
  if (/claude-3-5-|claude-3\.5/i.test(name)) return 8192;
  return 32000;
}
