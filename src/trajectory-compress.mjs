// Trajectory compression for training data (after Hermes Agent's
// trajectory_compressor.py): long agent runs are cut down to a token budget
// while keeping what a model needs to learn from them.
//
//   - The first system, user, assistant and tool turns stay verbatim, and so do
//     the last few turns (by default 4), so the task and its outcome survive.
//   - From the start of the middle, just enough turns to reach the budget are
//     replaced by one user turn starting "[CONTEXT SUMMARY]:", written by the
//     model (or a fixed notice when summarizing fails).
//   - An assistant turn with tool calls and the tool results that answer it are
//     one unit, so a call is never separated from its result.
//   - The system prompt gets a notice that earlier tool results may be summarized.
//
// Operates on OpenAI chat messages ({ role, content, tool_calls, tool_call_id }).

import { estimateTokens } from './context.mjs';

export const COMPRESSION_DEFAULTS = Object.freeze({ targetTokens: 15250, summaryTokens: 750, keepLast: 4 });
export const SUMMARY_PREFIX = '[CONTEXT SUMMARY]:';
export const SUMMARY_NOTICE = '\n\nSome of your previous tool responses may be summarized to preserve context.';
export const SUMMARY_FALLBACK = SUMMARY_PREFIX + ' [Summary generation failed - previous turns contained tool calls and responses that have been compressed to save context space.]';
const MAX_REGION_LINE = 4000;

/** Group messages into units: an assistant turn with tool calls owns the tool results after it. */
export function trajectoryUnits(messages = []) {
  const units = [];
  for (const message of messages) {
    const last = units[units.length - 1];
    if (message && message.role === 'tool' && last && last.some((item) => item.role === 'assistant' && Array.isArray(item.tool_calls) && item.tool_calls.length)) last.push(message);
    else units.push([message]);
  }
  return units;
}

const unitTokens = (unit) => estimateTokens(unit);
const hasRole = (unit, role) => unit.some((message) => message && message.role === role);

/**
 * Plan which units to replace. Returns { start, end, tokens } (end exclusive) or
 * null when the trajectory is under the target or nothing can be saved.
 */
export function planCompression(units, { targetTokens, summaryTokens, keepLast }) {
  const tokens = units.map(unitTokens);
  const total = tokens.reduce((sum, value) => sum + value, 0);
  if (total <= targetTokens) return { skipped: true, total };
  const protectedIndexes = new Set();
  for (const role of ['system', 'user', 'assistant', 'tool']) {
    const index = units.findIndex((unit) => hasRole(unit, role));
    if (index >= 0) protectedIndexes.add(index);
  }
  for (let index = Math.max(0, units.length - keepLast); index < units.length; index++) protectedIndexes.add(index);
  const middle = Math.floor(units.length / 2);
  const before = [...protectedIndexes].filter((index) => index < middle);
  const after = [...protectedIndexes].filter((index) => index >= middle);
  const start = before.length ? Math.max(...before) + 1 : 0;
  const end = after.length ? Math.min(...after) : units.length;
  if (start >= end) return { total, region: null };
  const needed = total - targetTokens + summaryTokens;
  let until = start;
  let saved = 0;
  while (until < end && saved < needed) { saved += tokens[until]; until++; }
  if (until <= start || saved <= summaryTokens) return { total, region: null };
  return { total, region: { start, end: until, tokens: saved } };
}

function text(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((part) => typeof part === 'string' ? part : part && part.text || '').join('');
  return content ? JSON.stringify(content) : '';
}

const clip = (value) => { const out = String(value || ''); return out.length > MAX_REGION_LINE ? out.slice(0, MAX_REGION_LINE) + ' [...]' : out; };

/** The turns to summarize as plain text for the summarizer. */
export function regionTranscript(messages) {
  const lines = [];
  for (const message of messages) {
    if (!message) continue;
    const body = text(message.content).trim();
    if (message.role === 'assistant') {
      if (body) lines.push('ASSISTANT: ' + clip(body));
      for (const call of message.tool_calls || []) lines.push('TOOL CALL ' + (call.function && call.function.name || '?') + ': ' + clip(call.function && call.function.arguments));
    } else if (message.role === 'tool') lines.push('TOOL RESULT: ' + clip(body));
    else lines.push(String(message.role || 'user').toUpperCase() + ': ' + clip(body));
  }
  return lines.join('\n');
}

export const SUMMARY_SYSTEM = 'You summarize part of an AI agent\'s work session so it can be used as training data. Write a factual, concise account of what the assistant did (tools called, files touched, commands run), what the results were, the decisions and findings, and any specific data, file names, values or outputs that later turns may rely on. No commentary, no advice, no markdown headings.';

export function summaryPrompt(transcript, summaryTokens) {
  return 'Summarize these turns in about ' + summaryTokens + ' tokens (' + Math.round(summaryTokens * 0.75) + ' words). Start with "' + SUMMARY_PREFIX + '".\n\n--- TURNS ---\n' + transcript + '\n--- END ---';
}

function withPrefix(summary) {
  const body = String(summary || '').trim().replace(/^\[CONTEXT SUMMARY\]:\s*/i, '');
  return body ? SUMMARY_PREFIX + ' ' + body : '';
}

/**
 * Compress one list of chat messages. `summarize(transcript, summaryTokens)`
 * returns the summary text (any prefix is normalized). Returns
 * { messages, metrics } with Hermes-compatible metric fields.
 */
export async function compressMessages(messages = [], options = {}) {
  const targetTokens = Math.max(500, Number(options.targetTokens) || COMPRESSION_DEFAULTS.targetTokens);
  const summaryTokens = Math.max(50, Math.min(targetTokens / 2, Number(options.summaryTokens) || COMPRESSION_DEFAULTS.summaryTokens));
  const keepLast = Math.max(0, Number.isFinite(Number(options.keepLast)) ? Number(options.keepLast) : COMPRESSION_DEFAULTS.keepLast);
  const units = trajectoryUnits(messages);
  const plan = planCompression(units, { targetTokens, summaryTokens, keepLast });
  const metrics = {
    original_tokens: plan.total, compressed_tokens: plan.total, tokens_saved: 0, compression_ratio: 1,
    original_turns: messages.length, compressed_turns: messages.length, turns_removed: 0,
    compression_region: null, was_compressed: false, still_over_limit: !plan.skipped && plan.total > targetTokens,
    skipped_under_target: Boolean(plan.skipped), summarization_api_calls: 0, summarization_errors: 0
  };
  if (!plan.region) return { messages, metrics };
  const { start, end } = plan.region;
  const replaced = units.slice(start, end).flat();
  let summary = '';
  if (typeof options.summarize === 'function') {
    metrics.summarization_api_calls = 1;
    try { summary = withPrefix(await options.summarize(regionTranscript(replaced), summaryTokens)); } catch { summary = ''; }
    if (!summary) metrics.summarization_errors = 1;
  }
  const head = units.slice(0, start).flat().map((message) => message && message.role === 'system' && !text(message.content).includes(SUMMARY_NOTICE.trim()) ? { ...message, content: text(message.content) + SUMMARY_NOTICE } : message);
  const out = [...head, { role: 'user', content: summary || SUMMARY_FALLBACK }, ...units.slice(end).flat()];
  const after = estimateTokens(out);
  const firstMessage = units.slice(0, start).flat().length;
  Object.assign(metrics, {
    compressed_tokens: after, tokens_saved: plan.total - after, compression_ratio: Math.round((after / plan.total) * 10_000) / 10_000,
    compressed_turns: out.length, turns_removed: messages.length - out.length,
    compression_region: { start_idx: firstMessage, end_idx: firstMessage + replaced.length, turns_count: replaced.length },
    was_compressed: true, still_over_limit: after > targetTokens
  });
  return { messages: out, metrics };
}

/** Running totals across a dataset, in the shape of Hermes' compression_metrics.json. */
export function newCompressionTotals() {
  return { started: Date.now(), total: 0, compressed: 0, skipped: 0, over: 0, failed: 0, before: 0, after: 0, turnsBefore: 0, turnsAfter: 0, calls: 0, errors: 0, ratios: [] };
}

export function addCompressionMetrics(totals, metrics) {
  totals.total++;
  if (!metrics) { totals.failed++; return totals; }
  if (metrics.was_compressed) { totals.compressed++; totals.ratios.push(metrics.compression_ratio); }
  if (metrics.skipped_under_target) totals.skipped++;
  if (metrics.still_over_limit) totals.over++;
  totals.before += metrics.original_tokens; totals.after += metrics.compressed_tokens;
  totals.turnsBefore += metrics.original_turns; totals.turnsAfter += metrics.compressed_turns;
  totals.calls += metrics.summarization_api_calls; totals.errors += metrics.summarization_errors;
  return totals;
}

export function compressionReport(totals) {
  const round = (value) => Math.round(value * 10_000) / 10_000;
  const compressed = totals.compressed || 0;
  const end = Date.now();
  return {
    summary: { total_trajectories: totals.total, trajectories_compressed: compressed, trajectories_skipped_under_target: totals.skipped, trajectories_still_over_limit: totals.over, trajectories_failed: totals.failed, compression_rate: totals.total ? round(compressed / totals.total) : 0 },
    tokens: { total_before: totals.before, total_after: totals.after, total_saved: totals.before - totals.after, overall_compression_ratio: totals.before ? round(totals.after / totals.before) : 1 },
    turns: { total_before: totals.turnsBefore, total_after: totals.turnsAfter, total_removed: totals.turnsBefore - totals.turnsAfter },
    averages: { avg_compression_ratio: compressed ? round(totals.ratios.reduce((a, b) => a + b, 0) / compressed) : 1, avg_tokens_saved_per_compressed: compressed ? Math.round((totals.before - totals.after) / compressed) : 0, avg_turns_removed_per_compressed: compressed ? round((totals.turnsBefore - totals.turnsAfter) / compressed) : 0 },
    summarization: { total_api_calls: totals.calls, total_errors: totals.errors, success_rate: totals.calls ? round((totals.calls - totals.errors) / totals.calls) : 1 },
    processing: { start_time: new Date(totals.started).toISOString(), end_time: new Date(end).toISOString(), duration_seconds: Math.round((end - totals.started) / 100) / 10 }
  };
}

/** A summarizer that uses the configured model provider (one tool-free request per trajectory). */
export async function providerSummarizer({ env = process.env, config = null, model = '' } = {}) {
  const { loadConfig } = await import('./config.mjs');
  const loaded = config || await loadConfig({ env });
  if (!loaded || loaded.configured === false) return null;
  const { completeText } = await import('./agent.mjs');
  const session = { config: model ? { ...loaded, model } : loaded, providerEnv: env, tokenUsage: {} };
  return (transcript, summaryTokens) => completeText(session, SUMMARY_SYSTEM, summaryPrompt(transcript, summaryTokens), { env });
}
