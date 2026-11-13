// Model budgets: per-turn tool-call and output-token limits (and the caps providers report),
// thinking budgets from prompt keywords (think hard, ultrathink), /effort and inline effort:LEVEL,
// and how a level maps to OpenAI reasoning effort and Anthropic thinking.
// Extracted from agent.mjs, which re-exports the public names.
import { findCatalogModel } from './model-catalog.mjs';
import { contextWindowSize, compactionThresholdChars } from './context.mjs';

// Output-token limits. OASIS uses a conservative model-based default with an
// optional environment/configuration override. Older models with
// smaller caps get a conservative default; a provider 400 that names the real
// cap lowers it for the rest of the session instead of failing the turn.
const MAX_TURN_TOOL_CALLS = 2000;
const DEFAULT_TURN_TOOL_CALLS = 300;
const DEFAULT_OUTPUT_CEILING = 32000;
const LEGACY_8K_MODELS = /claude-(instant|2)|claude-3-(opus|sonnet|haiku)|claude-3-5-|claude-3\.5|gpt-3\.5|gpt-4(?!o|\.1|-turbo)/i;
const MODERN_32K_MODELS = /claude|gpt-5|\bo[1-9](-|$)|gpt-4\.1|gemini-(2|3)|deepseek|qwen3|kimi|glm-4\.[5-9]|grok-[3-9]/i;
function strictConfiguredInteger(value) {
  const raw = typeof value === 'number' ? value : String(value ?? '').trim();
  if (typeof raw === 'string' && !/^\d+$/.test(raw)) return 0;
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

export function firstPositiveConfiguredInteger(...values) {
  for (const value of values) {
    const parsed = strictConfiguredInteger(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function boundedTurnInteger(primary, fallback, defaultValue, min, max) {
  let value = strictConfiguredInteger(primary);
  if (value <= 0) value = strictConfiguredInteger(fallback);
  if (value <= 0) value = defaultValue;
  return Math.max(min, Math.min(max, value));
}

export function resolveTurnLimits(options = {}, config = {}) {
  return {
    maxSteps: boundedTurnInteger(options.maxSteps, config.maxSteps, 60, 1, 400),
    tokenBudget: boundedTurnInteger(options.maxTokens, config.maxTokens, 2000000, 10000, 20000000),
    maxToolCalls: boundedTurnInteger(options.maxToolCalls, config.maxToolCalls, DEFAULT_TURN_TOOL_CALLS, 1, MAX_TURN_TOOL_CALLS)
  };
}

export function maxOutputTokensFor(config = {}, env = process.env) {
  const configured = firstPositiveConfiguredInteger(env.OASIS_MAX_OUTPUT_TOKENS, env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, config.maxOutputTokens);
  if (configured > 0) return Math.max(1024, Math.min(128000, configured));
  const model = String(config.model || '');
  // models.dev lists each model's real output limit. Use it up to 32,000 (the
  // per-request ceiling Claude Code also defaults to) and never more than a
  // quarter of the context window, which some OpenAI-compatible servers count
  // max_tokens against. The name patterns below cover models it does not list.
  const listed = findCatalogModel(model, { baseURL: config.baseURL, provider: config.catalogProvider, env });
  if (listed && listed.output > 0) {
    const room = listed.context > 0 ? Math.floor(listed.context / 4) : Infinity;
    return Math.max(1024, Math.min(DEFAULT_OUTPUT_CEILING, listed.output, room));
  }
  if (LEGACY_8K_MODELS.test(model) && !/claude-3-7|claude-3\.7/i.test(model)) return 8192;
  if (MODERN_32K_MODELS.test(model)) return 32000;
  if (/gpt-4o|gpt-4-turbo/i.test(model)) return 16384;
  return 8192;
}

/** Parse the real maximum out of a provider "max_tokens too large" error, if any. */
export function outputCapFromError(status, body) {
  if (status !== 400) return 0;
  const text = String(body || '');
  if (!/max_tokens|max_output_tokens|max_completion_tokens|maximum (allowed )?(number of )?output tokens/i.test(text)) return 0;
  const explicit = text.match(/>\s*(\d{3,6})\b/) || text.match(/(?:maximum|max|up to|at most|limit(?: is)?)[^\d]{0,60}(\d{3,6})/i);
  const parsed = explicit ? Number.parseInt(explicit[1], 10) : 0;
  return parsed >= 1024 ? parsed : 8192;
}

export function isOpenRouterBaseURL(baseURL) {
  try {
    const host = new URL(String(baseURL || '')).hostname.toLowerCase();
    return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
  } catch { return false; }
}

export function openRouterCreditInfo(status, body, baseURL) {
  if (status !== 402 || !isOpenRouterBaseURL(baseURL)) return null;
  let parsed;
  try { parsed = JSON.parse(String(body || '').slice(0, 16000)); } catch { return null; }
  const error = parsed && parsed.error;
  if (!error || !error.metadata || error.metadata.limit_source !== 'openrouter_credits') return null;
  const message = String(error.message || '');
  const availableMatch = message.match(/can only afford\s+([\d,]+)/i);
  const requestedMatch = message.match(/requested up to\s+([\d,]+)/i);
  const available = availableMatch ? Number(availableMatch[1].replace(/,/g, '')) : 0;
  if (!Number.isSafeInteger(available) || available <= 0) return null;
  return { available, requested: requestedMatch ? Number(requestedMatch[1].replace(/,/g, '')) : 0 };
}

export function openRouterOutputCapFromError(status, body, config = {}) {
  const info = openRouterCreditInfo(status, body, config.baseURL);
  if (!info || info.available < 80) return 0;
  return Math.floor((info.available * 0.8) / 64) * 64;
}

export const MAX_OUTPUT_RECOVERIES = 3;
export function truncationRecoveryPrompt(limit, droppedCall) {
  return [
    'Your previous response hit the ' + limit + '-token output limit and was cut off.',
    droppedCall ? 'The `' + droppedCall + '` tool call was incomplete and was NOT executed; nothing changed from it.' : '',
    'Resume directly from where you stopped — no apology and no recap of earlier text.',
    droppedCall ? 'Break the work into smaller pieces: e.g. write a large file as a short first part with write_file, then add the rest with several edit_file/multi_edit calls, or split long commands.' : ''
  ].filter(Boolean).join(' ');
}

// OASIS prompt keywords can request a larger per-turn reasoning budget.
// MAX_THINKING_TOKENS / OASIS_THINKING_BUDGET or config.thinkingBudget set a default.
export function thinkingBudgetFor(prompt, config = {}, env = process.env) {
  if (thinkingTurnedOff(config, env)) return 0;
  // Claude Code's alwaysThinkingEnabled: false turns thinking off unless MAX_THINKING_TOKENS
  // (or OASIS_THINKING_BUDGET) asks for a positive budget for this session.
  if (config.alwaysThinkingEnabled === false) {
    const forced = firstPositiveConfiguredInteger(env.OASIS_THINKING_BUDGET, env.MAX_THINKING_TOKENS);
    return forced ? Math.max(1024, Math.min(forced, 64000)) : 0;
  }
  const text = String(prompt || '').toLowerCase();
  let budget = 0;
  // OASIS_DISABLE_THINK_KEYWORDS / CLAUDE_CODE_DISABLE_ULTRATHINK: words like "think hard" in
  // pasted text (logs, docs) no longer raise the budget; configured defaults still apply.
  const keywordsOff = env.OASIS_DISABLE_THINK_KEYWORDS === '1' || env.CLAUDE_CODE_DISABLE_ULTRATHINK === '1';
  if (keywordsOff) { /* keyword boosts disabled */ }
  else if (/\bultrathink\b|\bthink (?:harder|intensely|super hard|really hard|very hard)\b/.test(text)) budget = 31999;
  else if (/\bmegathink\b|\bthink (?:hard|deeply|a lot|more)\b/.test(text)) budget = 10000;
  else if (/\bthink\b/.test(text) && /\b(?:think (?:about|through|carefully|step)|please think|let'?s think)\b/.test(text)) budget = 4000;
  const configured = firstPositiveConfiguredInteger(env.OASIS_THINKING_BUDGET, env.MAX_THINKING_TOKENS, config.thinkingBudget);
  budget = Math.max(budget, configured);
  if (['0', 'off', 'false'].includes(String(env.OASIS_THINKING || '').toLowerCase())) return 0;
  return budget ? Math.max(1024, Math.min(budget, 64000)) : 0;
}

// /effort: a session-wide override. low/medium/high/max map to a thinking budget
// (Anthropic) and a reasoning effort (OpenAI reasoning models); prompt keywords
// such as "ultrathink" can still raise it for one turn. auto (null) restores base.
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'max', 'auto'];
const INLINE_EFFORT = /(^|\s)effort:(low|medium|high|max)(?=\s|$|[.,;!?])/i;
export function inlineEffortLevel(prompt) {
  const match = INLINE_EFFORT.exec(String(prompt || ''));
  return match ? match[2].toLowerCase() : null;
}
export function stripInlineEffort(text) {
  return typeof text === 'string' ? text.replace(INLINE_EFFORT, '$1').trim() : text;
}
// Subagent effort: agent frontmatter `effort:` wins, then OASIS_SUBAGENT_EFFORT /
// CLAUDE_CODE_SUBAGENT_EFFORT, then settings `subagentEffort`. Lets a cheap low-effort
// explorer run under a high-effort main session (or the reverse).
export function subagentEffortConfig(parent, agent, env, config) {
  const level = [agent && agent.effort, env.OASIS_SUBAGENT_EFFORT, env.CLAUDE_CODE_SUBAGENT_EFFORT, parent.subagentEffort]
    .map((value) => String(value || '').trim().toLowerCase()).find((value) => ['low', 'medium', 'high', 'max'].includes(value));
  const withEffort = level ? applyEffort(config, level) : config;
  // Subagents can compact at their own threshold (OASIS_SUBAGENT_AUTOCOMPACT_PCT or settings
  // subagentAutoCompactPercent; 0 turns it off), separate from the coordinator's.
  const raw = env.OASIS_SUBAGENT_AUTOCOMPACT_PCT !== undefined && env.OASIS_SUBAGENT_AUTOCOMPACT_PCT !== '' ? env.OASIS_SUBAGENT_AUTOCOMPACT_PCT : parent.subagentAutoCompactPercent;
  const pct = raw === undefined || raw === null || raw === '' ? NaN : Number(raw);
  const withCompact = Number.isInteger(pct) && pct >= 0 && pct <= 100 ? { ...withEffort, autoCompactPercent: pct } : withEffort;
  // autoCompactWindow (Claude Code front matter) only lowers the window compaction is measured against.
  const window = Number(agent && agent.autoCompactWindow);
  if (!window || window >= contextWindowSize(withCompact, env)) return withCompact;
  return { ...withCompact, compactThresholdChars: compactionThresholdChars({ ...withCompact, contextWindow: window }, env) };
}
const EFFORT_SETTINGS = { low: ['low', 4000], medium: ['medium', 10000], high: ['high', 32000], max: ['high', 63999] };
// OpenAI reasoning effort a model accepts. `max` exists on GPT-5.6+ and GPT-6,
// `xhigh` from GPT-5.2; GPT-6 models reject `none` and `minimal` with HTTP 400.
// Unknown models pass through unchanged.
export function openaiEffortFor(model, effort) {
  const value = String(effort || '').toLowerCase();
  if (!value) return '';
  const name = String(model || '').toLowerCase();
  const gpt6 = /gpt-6/.test(name);
  const gpt5 = name.match(/gpt-5(?:\.(\d+))?/);
  const minor = gpt5 ? Number(gpt5[1] || 0) : -1;
  const oSeries = /(?:^|\/)o\d/.test(name);
  if (!gpt6 && !gpt5 && !oSeries) return value;
  const top = gpt6 || minor >= 6 ? 'max' : minor >= 2 ? 'xhigh' : 'high';
  const order = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  let index = order.indexOf(value);
  if (index < 0) return value;
  if (index > order.indexOf(top)) index = order.indexOf(top);
  if (gpt6 && index < order.indexOf('low')) index = order.indexOf('low');
  return order[index];
}
export function applyEffort(config = {}, level, base = {}) {
  const next = { ...config };
  const chosen = level && EFFORT_SETTINGS[level];
  let [reasoningEffort, thinkingBudget] = chosen || [base.reasoningEffort, base.thinkingBudget];
  // `max` asks for the deepest reasoning the OpenAI model offers.
  if (chosen && level === 'max') reasoningEffort = openaiEffortFor(config.model || base.model, 'max') || reasoningEffort;
  if (reasoningEffort) next.reasoningEffort = reasoningEffort; else delete next.reasoningEffort;
  if (thinkingBudget) next.thinkingBudget = thinkingBudget; else delete next.thinkingBudget;
  // Claude models with adaptive thinking take the level itself (output_config.effort).
  const effortLevel = chosen ? level : base.effortLevel;
  if (effortLevel) next.effortLevel = effortLevel; else delete next.effortLevel;
  return next;
}

// How a Claude model takes thinking settings (platform.claude.com, thinking docs):
//   'budget'        thinking: { type: 'enabled', budget_tokens } (Claude 4.5 and
//                   earlier, and Anthropic-compatible non-Claude models);
//   'adaptive'      Claude 4.6: thinking: { type: 'adaptive' } + output_config.effort
//                   (budget_tokens still works but is deprecated);
//   'adaptive-only' Claude 4.7 and later (Opus 5/5.5, Sonnet 5/5.5, Fable, Mythos,
//                   Haiku 5.5): budget_tokens and forced tool_choice return 400.
// Thinking is off for the session: OASIS_THINKING=0, MAX_THINKING_TOKENS=0, or
// alwaysThinkingEnabled: false without a positive MAX_THINKING_TOKENS / OASIS_THINKING_BUDGET.
export function thinkingTurnedOff(config = {}, env = process.env) {
  if (['0', 'off', 'false'].includes(String(env.OASIS_THINKING || '').toLowerCase())) return true;
  if (String(env.MAX_THINKING_TOKENS ?? '').trim() === '0' && !firstPositiveConfiguredInteger(env.OASIS_THINKING_BUDGET)) return true;
  return config.alwaysThinkingEnabled === false && !firstPositiveConfiguredInteger(env.OASIS_THINKING_BUDGET, env.MAX_THINKING_TOKENS);
}

export function claudeThinkingMode(model) {
  const id = String(model || '').toLowerCase();
  if (!/claude|\b(?:opus|sonnet|haiku|fable|mythos)\b/.test(id)) return 'budget';
  if (/fable|mythos/.test(id)) return 'adaptive-only';
  if (/claude-(?:instant|2|3)(?:[-.]|$)/.test(id)) return 'budget';
  const match = id.match(/(opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2})(?!\d))?/);
  if (!match) return 'budget';
  const version = Number(match[2]) + (match[3] ? Number(match[3]) / 10 : 0);
  if (version >= 4.7) return 'adaptive-only';
  if (version >= 4.6) return 'adaptive';
  return 'budget';
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
// Maps /effort and think-keyword budgets onto Claude effort levels. Keywords only
// raise effort (a plain "think" never lowers a model's default); `xhigh` exists
// from Claude 4.7 on, so 4.6 gets `high` instead.
export function claudeEffortFor(model, { level = '', budget = 0 } = {}) {
  const mode = claudeThinkingMode(model);
  if (mode === 'budget') return '';
  const fromBudget = budget >= 63999 ? 'max' : budget >= 31999 ? 'xhigh' : budget >= 10000 ? 'high' : '';
  const explicit = CLAUDE_EFFORTS.includes(String(level)) ? String(level) : '';
  let effort = CLAUDE_EFFORTS.indexOf(fromBudget) > CLAUDE_EFFORTS.indexOf(explicit) ? fromBudget : explicit;
  if (effort === 'xhigh' && mode !== 'adaptive-only') effort = 'high';
  return effort;
}

// OpenAI reasoning models (o-series, gpt-5): the same think keywords map to
// reasoning effort. Sent only for reasoning models or when configured explicitly,
// because other chat-completions providers reject the field.
export function reasoningEffortFor(prompt, config = {}, env = process.env) {
  if (['0', 'off', 'false'].includes(String(env.OASIS_THINKING || '').toLowerCase())) return '';
  // none/xhigh exist on newer OpenAI reasoning models; they are only sent when configured.
  const valid = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  const configured = String(env.OASIS_REASONING_EFFORT || config.reasoningEffort || '').toLowerCase();
  const explicit = valid.includes(configured);
  if (!explicit && !/^(?:[\w.-]+\/)?(?:o\d|gpt-[5-9])/i.test(String(config.model || ''))) return '';
  const budget = thinkingBudgetFor(prompt, { ...config, thinkingBudget: 0 }, { ...env, OASIS_THINKING_BUDGET: '', MAX_THINKING_TOKENS: '' });
  const fromPrompt = budget >= 31999 ? 'high' : budget >= 10000 ? 'medium' : budget ? 'low' : '';
  const chosen = !fromPrompt ? (explicit ? configured : '')
    : explicit && valid.indexOf(configured) > valid.indexOf(fromPrompt) ? configured : fromPrompt;
  return openaiEffortFor(config.model, chosen);
}
