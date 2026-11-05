// Idle compaction: while you are away from the prompt, fold older history into
// a summary so the next turn starts smaller and faster.
//
// Why while idle: provider prompt caches expire after minutes of inactivity
// (5 minutes by default on Anthropic, similar elsewhere), so the next request
// would re-read the whole history at full price anyway. Summarizing during the
// pause costs one summary call and makes every following request cheaper,
// without making you wait for compaction when you come back.
//
// It only runs between turns at the interactive prompt, only once per pause,
// only when the conversation has reached half of the normal auto-compaction
// threshold, and it is dropped without changes if you start typing first.
// /compact undo restores the full history.

import { compactionThresholdChars } from './context.mjs';

export const DEFAULT_IDLE_COMPACT_MINUTES = 15;
// Below this much history (about 10k tokens) a summary is not worth a model call.
export const IDLE_COMPACT_MIN_CHARS = 40_000;
export const IDLE_COMPACT_FRACTION = 0.5;

/** Minutes of inactivity before idle compaction, or 0 when it is off. */
export function idleCompactMinutes(settings = {}, env = process.env) {
  const raw = env.OASIS_IDLE_COMPACT_MINUTES !== undefined && env.OASIS_IDLE_COMPACT_MINUTES !== '' ? env.OASIS_IDLE_COMPACT_MINUTES : settings && settings.idleCompactMinutes;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_IDLE_COMPACT_MINUTES;
  if (raw === false || /^(off|false|no)$/i.test(String(raw))) return 0;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(24 * 60, Math.max(1, value));
}

export function historyChars(messages = []) {
  let total = 0;
  for (const message of messages) {
    if (!message) continue;
    if (typeof message.content === 'string') total += message.content.length;
    else if (Array.isArray(message.content)) for (const part of message.content) total += typeof part === 'string' ? part.length : String(part && (part.text || '')).length;
    if (Array.isArray(message.tool_calls)) { try { total += JSON.stringify(message.tool_calls).length; } catch {} }
  }
  return total;
}

/** The lowered threshold (in characters) idle compaction uses, or 0 when the history is too small. */
export function idleCompactThreshold(session, env = process.env) {
  if (!session || !Array.isArray(session.messages) || session.messages.length < 6) return 0;
  const normal = compactionThresholdChars(session.config || {}, env);
  if (normal >= 8_000_000) return 0; // auto-compaction turned off
  const threshold = Math.max(IDLE_COMPACT_MIN_CHARS, Math.floor(normal * IDLE_COMPACT_FRACTION));
  return historyChars(session.messages) >= threshold ? threshold : 0;
}

/**
 * Arms a timer while the prompt waits for input. `compact(session, options)` is
 * compactHistoryIfNeeded; it receives a lowered threshold and an abort signal.
 * Call settle() once input arrives: it cancels a running summary (nothing is
 * changed) and returns what happened during the pause.
 */
export function startIdleCompaction(session, { minutes, env = process.env, compact, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  const state = { status: 'waiting', result: null, promise: null, startedAt: 0 };
  if (!(minutes > 0) || typeof compact !== 'function' || !session) return { settle: async () => null, state };
  const controller = new AbortController();
  const timer = setTimer(() => {
    const threshold = idleCompactThreshold(session, env);
    if (!threshold) { state.status = 'skipped'; return; }
    state.status = 'running';
    state.startedAt = now();
    let started;
    try { started = Promise.resolve(compact(session, { env, thresholdChars: threshold, signal: controller.signal, discardOnAbort: true, idle: true })); }
    catch (error) { started = Promise.reject(error); }
    state.promise = started
      .then((result) => { state.result = result || null; state.status = result && result.compacted ? 'compacted' : (result && result.cancelled ? 'cancelled' : 'skipped'); })
      .catch(() => { state.status = 'failed'; });
  }, Math.round(minutes * 60_000));
  if (timer && typeof timer.unref === 'function') timer.unref();
  return {
    state,
    async settle() {
      clearTimer(timer);
      if (state.status === 'running') { controller.abort(); await state.promise; }
      return state.status === 'compacted' ? state.result : null;
    }
  };
}

/** One dim line for the transcript after a pause, or ''. */
export function idleCompactionNote(info) {
  if (!info || !info.compacted) return '';
  const before = Number(info.beforeTokens) || 0;
  const after = Number(info.afterTokens) || 0;
  const sizes = before && after ? ' (~' + Math.round(before / 1000) + 'k → ~' + Math.round(after / 1000) + 'k tokens)' : '';
  return '[compact] While you were away, older history was summarized' + sizes + ' so the next turn starts faster. /compact undo restores it.';
}
