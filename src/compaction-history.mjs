// History compaction helpers: size accounting, the deterministic fallback summary, where a
// compaction may cut, reporting and undoing a compaction, and lossless superseding first.
// Extracted from agent.mjs, which re-exports the public names.
import { supersedeHistory } from './superseded-results.mjs';
import { estimateTokens, tokenUpperBound } from './context.mjs';
import { saveSessionNotes } from './session-notes.mjs';

export const HISTORY_COMPACT_THRESHOLD_CHARS = 60000;
const HISTORY_COMPACT_KEEP_MESSAGES = 28;
export const HISTORY_COMPACT_INPUT_LIMIT = 32000;

export function historyTextSize(messages) {
  return messages.reduce((total, message) => total + String(message && message.content || '').length, 0);
}

// Size compared against the character-based compaction thresholds: the larger of
// the raw characters and the BPE token count at the nominal 4 characters per
// token. Dense JSON, logs and non-Latin scripts carry more tokens per character
// than English, so counting characters alone let them overflow the window.
export function historyBudgetSize(messages) {
  return Math.max(historyTextSize(messages), estimateTokens(messages) * 4);
}

// historyBudgetSize(messages) <= limit, without loading the tokenizer when the
// byte count already proves it: a short session's first turn used to spend
// ~160 ms (and the vocabulary's memory) counting a prompt far below any limit.
export function historyWithinBudget(messages, limit) {
  if (historyTextSize(messages) > limit) return false;
  if (tokenUpperBound(messages) * 4 <= limit) return true;
  return historyBudgetSize(messages) <= limit;
}

export function safeHistoryLine(message) {
  const role = String(message && message.role || 'unknown').toUpperCase();
  if (role === 'USER') return 'USER: ' + String(message.content || '').slice(0, 1800);
  if (role === 'ASSISTANT') {
    const calls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => {
          const fn = call.function || {};
          return String(fn.name || 'unknown') + '(' + String(fn.arguments || '{}').slice(0, 500) + ')';
        }).join(', ')
      : '';
    const content = String(message.content || '').slice(0, 1300);
    return 'ASSISTANT: ' + content + (calls ? '\nTOOL CALLS: ' + calls : '');
  }
  if (role === 'TOOL') return 'TOOL ' + String(message.name || 'unknown') + ': ' + String(message.content || '').slice(0, 650);
  return '';
}

// Head and tail of an oversized piece, with a marker giving the size left out.
function clipMiddle(text, max) {
  const value = String(text == null ? '' : text);
  if (value.length <= max) return value;
  const head = Math.floor(max * 0.65);
  const tail = max - head;
  return value.slice(0, head) + ' [... ' + (value.length - head - tail) + ' characters omitted ...] ' + value.slice(-tail);
}

// One line of the transcript a compaction summary is written from. The local
// digest (safeHistoryLine) is small by design; the model summarizer got the same
// 1,800 / 1,300 / 650-character cuts, so a long user spec lost its later
// requirements and tool results (where the findings are) were nearly gone
// before the model ever saw them. Here they keep far more, head and tail.
export function summaryHistoryLine(message) {
  const role = String(message && message.role || 'unknown').toUpperCase();
  const content = typeof (message && message.content) === 'string' ? message.content : (message && message.content != null ? JSON.stringify(message.content) : '');
  if (role === 'USER') return 'USER: ' + clipMiddle(content, 20000);
  if (role === 'ASSISTANT') {
    const calls = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call) => {
          const fn = call.function || {};
          return String(fn.name || 'unknown') + '(' + clipMiddle(fn.arguments || '{}', 1500) + ')';
        }).join(', ')
      : '';
    return 'ASSISTANT: ' + clipMiddle(content, 6000) + (calls ? '\nTOOL CALLS: ' + calls : '');
  }
  if (role === 'TOOL') return 'TOOL ' + String(message.name || 'unknown') + ': ' + clipMiddle(content, 4000);
  return '';
}

// The transcript for the summarizer, within maxChars: the first user message
// (usually the task itself) is always kept, then the newest whole lines, with
// a marker where older lines were left out. A raw tail slice dropped the
// original request first and could cut a line in half.
export function summaryTranscript(messages, maxChars) {
  const lines = (messages || []).map(summaryHistoryLine).filter(Boolean);
  const total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  if (total <= maxChars) return lines.join('\n');
  const firstUser = lines.findIndex((line) => line.startsWith('USER: '));
  const head = firstUser >= 0 ? clipMiddle(lines[firstUser], Math.floor(maxChars / 4)) : '';
  const room = maxChars - head.length - 80;
  const kept = [];
  let used = 0;
  for (let i = lines.length - 1; i > firstUser; i--) {
    const cost = lines[i].length + 1;
    if (used + cost > room) {
      if (!kept.length) kept.push(clipMiddle(lines[i], Math.max(0, room)));
      break;
    }
    kept.unshift(lines[i]);
    used += cost;
  }
  const omitted = lines.length - kept.length - (head ? 1 : 0);
  return [head, omitted > 0 ? '[... ' + omitted + ' earlier transcript lines omitted ...]' : '', ...kept].filter(Boolean).join('\n');
}

export function deterministicHistorySummary(messages) {
  const lines = messages.map(safeHistoryLine).filter(Boolean);
  const text = lines.join('\n');
  return (text.length > 16000 ? '[Earlier history clipped; most recent details retained]\n' + text.slice(-16000) : text) || 'No usable earlier conversation details were available.';
}

// Compaction must never look like a freeze: the summary request gets its own
// hard deadline (OASIS_COMPACT_TIMEOUT_SECONDS, default 90) and falls back to the
// deterministic local summary when the model is slow or unavailable.
export function compactionDeadline(options = {}) {
  const env = options.env || process.env;
  const seconds = Number(env.OASIS_COMPACT_TIMEOUT_SECONDS);
  const ms = Math.round((Number.isFinite(seconds) && seconds > 0 ? seconds : 90) * 1000);
  const deadline = AbortSignal.timeout(ms);
  const signal = options.signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([options.signal, deadline]) : (options.signal || deadline);
  return { signal, ms, timedOut: () => deadline.aborted && !(options.signal && options.signal.aborted) };
}

export function compactionError(deadline, error) {
  return deadline.timedOut() ? new Error('Compaction summary took longer than ' + Math.round(deadline.ms / 1000) + 's; used a local summary instead (OASIS_COMPACT_TIMEOUT_SECONDS).') : error;
}

export function announceCompaction(options, info) {
  if (typeof options.onCompactionStart !== 'function') return;
  try { options.onCompactionStart(info); } catch {}
}

export async function reportCompaction(session, summary, beforeTokens, options = {}, details = {}) {
  const afterTokens = estimateTokens(session.messages || []);
  const savedTokens = Math.max(0, beforeTokens - afterTokens);
  const note = 'Saved about ' + savedTokens.toLocaleString('en-US') +
    ' tokens by compacting older conversation history.';
  let notesSaved = false;
  if (session.root && !options.isSubagent && options.persistSessionNotes !== false) {
    try {
      const result = await saveSessionNotes(session.root, summary, { savedTokens });
      notesSaved = Boolean(result.saved);
    } catch (error) {
      if (typeof options.onCompactionError === 'function') {
        try { options.onCompactionError(error); } catch {}
      }
    }
  }
  const info = {
    ...details,
    beforeTokens,
    afterTokens,
    savedTokens,
    note,
    notesSaved,
    notesPath: notesSaved ? '.oasis/session-notes.md' : null
  };
  if (typeof options.onCompaction === 'function') {
    try { await options.onCompaction(info); } catch (error) {
      if (typeof options.onCompactionError === 'function') {
        try { options.onCompactionError(error); } catch {}
      }
    }
  }
  return info;
}
export function findCompactionBoundary(messages) {
  const minimumIndex = Math.max(2, messages.length - HISTORY_COMPACT_KEEP_MESSAGES);
  for (let i = minimumIndex; i < messages.length; i++) {
    if (messages[i].role !== 'user') continue;
    const previous = messages[i - 1];
    if (previous && previous.role === 'assistant' && !(Array.isArray(previous.tool_calls) && previous.tool_calls.length)) {
      return i;
    }
  }
  return -1;
}

/**
 * Compress completed conversation turns before a new user request. The model only
 * summarizes a bounded, plain-text transcript and has no tools during this step.
 * If the provider cannot summarize, a local deterministic digest prevents history
 * growth from making the next coding request unusable.
 */
export function undoCompaction(session) {
  const undo = session && session.compactionUndo;
  if (!undo || !Array.isArray(undo.messages)) return { restored: false };
  // History was rewound or cleared past the compaction point: undoing would resurrect it.
  if (!Array.isArray(session.messages) || session.messages.length < undo.afterLength) { delete session.compactionUndo; return { restored: false }; }
  const added = (session.messages || []).slice(undo.afterLength);
  session.messages = [...undo.messages, ...added];
  delete session.compactionUndo;
  return { restored: true, messages: session.messages.length, carriedOver: added.length, trigger: undo.trigger };
}

// A compaction reply replaces real history, so it must look like a summary: not
// empty, not a refusal, and not a tool call or a plan to act (a model that keeps
// working instead of summarizing). Returns '' when the reply is unusable.
export function usableCompactionSummary(text) {
  const summary = String(text || '').trim();
  if (!summary) return '';
  const head = summary.slice(0, 200);
  if (/^(?:I(?:'m| am)? (?:sorry|unable|not able)|I can(?:'|no)t|Sorry\b|As an AI\b)/i.test(head)) return '';
  if (/^(?:<tool_call>|<function=|\{\s*"(?:name|tool|function|arguments)"\s*:)/i.test(head)) return '';
  if (/^(?:Let me|I(?:'ll| will) (?:now |first |start |begin |run |check |read |look |continue))/i.test(head)) return '';
  return summary;
}

// Before anything lossy (a model summary, pruning old tool output), drop the
// tool results that a newer result already covers: older reads of a file that
// was read again, earlier runs of a command that ran again. Returns how many
// results were replaced.
export function supersedeBeforeCompaction(session, options = {}) {
  const lossless = supersedeHistory(session.messages || [], { root: session.root, env: options.env || process.env, config: session.config || {} });
  if (!lossless.replaced) return 0;
  session.messages = lossless.messages;
  session.supersededResultChars = (session.supersededResultChars || 0) + lossless.saved;
  return lossless.replaced;
}
