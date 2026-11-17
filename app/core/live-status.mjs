// The live status of a running turn in the web app: what OASIS is waiting
// on this moment, said honestly.
//
// A model request has phases a person can tell apart, and each one reads
// differently: the request is out and nothing came back yet (a cloud model
// is thinking, a local model is reading the prompt), the provider reports
// how much of the prompt it has read, reasoning streams, the reply or a tool
// call streams, or output stops arriving for a while. Saying "Thinking" for
// all of them makes a slow local model look hung and a hung provider look
// busy. The terminal says the same things (src/activity-indicator.mjs and
// src/turn-status.mjs); this is the browser's copy, pure and unit tested.
//
//   Waiting for qwen3 · 5.9k tokens sent
//   Reading the prompt · 54% of 5.9k tokens · about 1m 10s left
//   Thinking · ↓ 320 tokens
//   Writing src/app.mjs · 3.2 KB · ↓ 1.1k tokens · 4 tok/s
//   Responding · no new output for 25s

export function formatTokens(count) {
  const n = Math.max(0, Math.round(Number(count || 0)));
  if (n < 1000) return String(n);
  if (n < 100000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return Math.round(n / 1000) + 'k';
}

export function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(Number(ms || 0) / 1000));
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  return minutes + 'm ' + String(seconds % 60).padStart(2, '0') + 's';
}

// Rough output tokens for streamed characters (about four per token).
export const CHARS_PER_TOKEN = 4;
export function charsToTokens(chars) { return Math.max(0, Number(chars) || 0) / CHARS_PER_TOKEN; }

// After this long with no output in the middle of a reply, say so.
export const QUIET_AFTER_MS = 20_000;
// Before the first token: a cloud model is "Thinking" for this long, then
// the line admits it is still waiting.
export const SLOW_FIRST_TOKEN_MS = 45_000;

// llama.cpp prompt_progress ({ total, cache, processed, time_ms }) as
// "54% of 7.7k tokens · about 2m 40s left". Cached tokens count as read.
// Between reports (one per 2,048-token batch, which can take a minute on a
// laptop CPU) the figure moves on at the measured rate, never to 100%.
export function promptProgressText(progress, ageMs = 0) {
  if (!progress) return '';
  const total = Number(progress.total) || 0;
  let processed = Math.min(total, Number(progress.processed) || 0);
  if (total <= 0 || processed >= total) return '';
  const cache = Math.min(processed, Number(progress.cache) || 0);
  const timeMs = Number(progress.time_ms ?? progress.timeMs) || 0;
  const done = processed - cache;
  const rate = timeMs >= 2000 && done > 0 ? done / timeMs : 0;
  if (rate > 0 && ageMs > 0) processed = Math.min(total - 1, processed + rate * ageMs);
  const parts = [Math.floor(processed / total * 100) + '% of ' + formatTokens(total) + ' tokens'];
  if (rate > 0) parts.push('about ' + formatElapsed(Math.max(1000, (total - processed) / rate)) + ' left');
  return parts.join(' · ');
}

function shortModel(name) {
  const text = String(name || '').trim();
  if (!text) return '';
  const last = text.split('/').filter(Boolean).at(-1) || text;
  return last.length > 28 ? last.slice(0, 27) + '…' : last;
}

// A fresh state for one model request.
export function modelRequest({ startedAt = Date.now(), step = 1, inputTokens = 0, model = '', local = false } = {}) {
  return { startedAt: Number.isFinite(Number(startedAt)) ? Number(startedAt) : Date.now(), step: Number(step) || 1, inputTokens: Math.max(0, Number(inputTokens) || 0), model: String(model || ''), local: Boolean(local), firstOutputAt: 0, lastOutputAt: 0, progress: null, progressAt: 0, ended: false };
}

// The words for a model request nobody has heard back from yet.
export function waitingLabel(request, now = Date.now()) {
  if (!request) return 'Thinking';
  const elapsed = Math.max(0, now - request.startedAt);
  const progress = request.progress;
  if (progress && Number(progress.total) > 0 && Number(progress.processed) < Number(progress.total)) return 'Reading the prompt';
  if (request.local && elapsed >= 15_000 && request.inputTokens > 2000) return 'Reading the prompt';
  if (elapsed >= SLOW_FIRST_TOKEN_MS) return 'Still waiting for ' + (shortModel(request.model) || 'the model');
  return 'Thinking';
}

// Output rate over the turn so far, in tokens a second, once there is
// enough to measure (a few seconds of streaming).
export function outputRate(turn, now = Date.now()) {
  if (!turn || !turn.streamMs) return 0;
  const ms = turn.streamMs + (turn.streamingSince ? Math.max(0, now - turn.streamingSince) : 0);
  if (ms < 3000 || turn.outChars < 200) return 0;
  return charsToTokens(turn.outChars) / (ms / 1000);
}

// The status line under the conversation. state: {
//   label: what runs now ('Reading app.mjs', 'Writing src/a.mjs · 3 KB') or '',
//   phase: 'waiting' | 'thinking' | 'responding' | 'draft' | 'tool' | 'approval' | 'rate' | 'reconnecting' | '',
//   request: modelRequest() or null, turn: { outChars, streamMs, streamingSince },
//   rateLimitUntil, elapsedMs (the whole run) }
// Returns { label, meta: [..] } so the label can shimmer and the rest stays dim.
export function liveStatus(state = {}, now = Date.now()) {
  const meta = [];
  const request = state.request && !state.request.ended ? state.request : null;
  const turn = state.turn || { outChars: 0 };
  let label;
  if (state.phase === 'approval') label = 'Waiting for you';
  else if (state.phase === 'reconnecting') label = 'Reconnecting';
  else if (Number(state.rateLimitUntil) > now) { label = 'Rate limited'; meta.push('retrying in ' + formatElapsed(Number(state.rateLimitUntil) - now + 999)); }
  else if (state.label && state.phase !== 'waiting' && state.phase !== 'thinking') label = state.label;
  else if (request && !request.firstOutputAt) {
    label = waitingLabel(request, now);
    const reading = promptProgressText(request.progress, request.progressAt ? now - request.progressAt : 0);
    if (reading) meta.push(reading);
    else if (request.inputTokens > 0) meta.push(formatTokens(request.inputTokens) + ' tokens sent');
  } else label = state.label || (state.phase === 'responding' ? 'Responding' : 'Thinking');
  if (Number(state.elapsedMs) >= 0 && state.elapsedMs !== undefined) meta.unshift(formatElapsed(state.elapsedMs));
  const outTokens = charsToTokens(turn.outChars);
  if (outTokens >= 1) meta.push('↓ ' + formatTokens(outTokens) + ' tokens');
  const rate = request && request.local ? outputRate(turn, now) : 0;
  if (rate >= 0.5) meta.push((rate < 10 ? rate.toFixed(1).replace(/\.0$/, '') : Math.round(rate)) + ' tok/s');
  // Mid-reply silence: the model started answering, then went quiet.
  if (request && request.firstOutputAt && request.lastOutputAt && state.phase !== 'tool' && state.phase !== 'approval') {
    const quiet = now - request.lastOutputAt;
    if (quiet >= QUIET_AFTER_MS) meta.push('no new output for ' + formatElapsed(quiet));
  }
  return { label, meta };
}

// How long a finished reasoning block thought. A local model's wait before
// its first token is mostly reading the prompt, not thinking, so it is left
// out; a cloud model's first-token wait is its thinking time.
export function thoughtMs(request, settledAt = Date.now(), blockStartedAt = 0) {
  const end = Number(settledAt) || Date.now();
  if (!request) return Math.max(0, end - (Number(blockStartedAt) || end));
  const from = request.local && request.firstOutputAt ? request.firstOutputAt : request.startedAt;
  return Math.max(0, end - Math.max(from, Number(blockStartedAt) || 0));
}

// What a finished run did, for the line under it: "Edited 2 files +14 −3 ·
// read 3 files · ran 2 commands" (Cursor's "Edited 4 files, explored 3
// files +73 −12"). Counts only steps that ran and succeeded; '' for a run
// that only talked.
const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'notebook_edit', 'apply_patch']);
const READ_TOOLS = new Set(['read_file', 'read_many_files', 'view_image', 'notebook_read']);
const SEARCH_TOOLS = new Set(['grep', 'glob', 'glob_files', 'search_files', 'list_files', 'repo_map', 'codebase_search', 'find_files', 'session_search', 'memory_search']);
const COMMAND_TOOLS = new Set(['run_command', 'bash', 'shell', 'run_tests']);
const WEB_TOOLS = new Set(['web_search', 'fetch_url', 'web_fetch', 'browse']);
function plural(n, one, many = one + 's') { return n + ' ' + (n === 1 ? one : many); }
export function runSummary(tools = []) {
  const edited = new Set(), deleted = new Set(), read = new Set();
  let added = 0, removed = 0, searches = 0, commands = 0, web = 0, failed = 0;
  for (const tool of tools) {
    if (!tool || tool.ok === undefined) continue;
    if (tool.ok === false) { if (!tool.outcome || tool.outcome === 'failed' || tool.outcome === 'timed_out') failed++; continue; }
    const name = String(tool.name || '');
    const args = tool.args || {};
    const file = String(args.path || args.file_path || args.notebook_path || '').replace(/^\.\//, '');
    if (EDIT_TOOLS.has(name)) {
      edited.add(file || name + edited.size);
      if (tool.lines) { added += Math.max(0, Number(tool.lines.added) || 0); removed += Math.max(0, Number(tool.lines.removed) || 0); }
    } else if (name === 'delete_file') deleted.add(file || 'file' + deleted.size);
    else if (READ_TOOLS.has(name)) read.add(file || name + read.size);
    else if (SEARCH_TOOLS.has(name)) searches++;
    else if (COMMAND_TOOLS.has(name)) commands++;
    else if (WEB_TOOLS.has(name)) web++;
  }
  const parts = [];
  if (edited.size) parts.push('edited ' + plural(edited.size, 'file') + ((added || removed) ? ' ' + [added ? '+' + added : '', removed ? '−' + removed : ''].filter(Boolean).join(' ') : ''));
  if (deleted.size) parts.push('deleted ' + plural(deleted.size, 'file'));
  if (read.size) parts.push('read ' + plural(read.size, 'file'));
  if (searches) parts.push(plural(searches, 'search', 'searches'));
  if (commands) parts.push('ran ' + plural(commands, 'command'));
  if (web) parts.push(plural(web, 'web lookup'));
  if (failed) parts.push(plural(failed, 'step') + ' failed');
  if (!parts.length) return '';
  parts[0] = parts[0][0].toUpperCase() + parts[0].slice(1);
  return parts.join(' · ');
}
