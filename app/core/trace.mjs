// Run trace: the Activity panel's model of what the agent did.
//
// Built from the same display entries the transcript renders (user
// messages, assistant steps with their tools, notes, errors and the
// "Worked for" line), so the live view, a restored chat and another device
// all show the same trace. One turn per user message; each turn lists its
// tool calls in order with their outcome, timing and a position on the
// turn's time axis (the waterfall), plus the model requests in between
// when the runtime reported them. Pure (no DOM) and unit tested in Node.

import { toolKind, stepLabel, stepOutcome, summarizeArgs, formatDuration } from './timeline.mjs';

const EDIT_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'notebook_edit', 'apply_patch', 'delete_file', 'move_file', 'rename_file']);

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function stepPath(args = {}) {
  return String(args.path || args.file_path || args.notebook_path || '').replaceAll(String.fromCharCode(92), '/');
}

// How long the step sat waiting for the user's approval (part of its span).
function waitedMs(tool, span, now) {
  let total = Number(tool.waitedMs) || 0;
  if (finite(tool.waitStartedAt) !== null) total += Math.max(0, now - Number(tool.waitStartedAt));
  if (span) total = Math.min(total, span[1] - span[0]);
  return Math.max(0, Math.round(total));
}

function stepSpan(tool, now) {
  const start = finite(tool.startedAt);
  if (start === null) return null;
  let end = finite(tool.endedAt);
  if (end === null && Number.isFinite(Number(tool.durationMs))) end = start + Number(tool.durationMs);
  if (end === null) end = tool.ok === undefined ? now : start;
  return [start, Math.max(start, end)];
}

function modelSpans(timings = []) {
  const spans = [];
  for (const record of Array.isArray(timings) ? timings : []) {
    const start = finite(record && record.startedAt);
    const total = Number(record && record.totalMs);
    if (start === null || !Number.isFinite(total) || total < 0) continue;
    spans.push({
      step: Number(record.step) || spans.length + 1,
      startedAt: start,
      endedAt: start + total,
      durationMs: total,
      ttftMs: Number.isFinite(Number(record.ttftMs)) ? Number(record.ttftMs) : null,
      inputTokens: Number(record.inputTokens) || Number(record.inputEstimate) || 0,
      outputTokens: Number(record.outputTokens) || 0,
      toolCalls: Number(record.toolCalls) || 0,
      model: String(record.model || '')
    });
  }
  return spans;
}

/**
 * entries: the app's display array. options.now: the clock for running
 * steps; options.running: the last turn is still working; options.timings:
 * model timing records of the live run (not yet saved on a "worked" entry).
 * Returns { turns, totals }.
 */
export function buildTrace(entries = [], { now = Date.now(), running = false, timings = [] } = {}) {
  const turns = [];
  let turn = null;
  const open = (entry, index) => {
    turn = { index: turns.length + 1, entryIndex: index, prompt: String(entry && entry.content || ''), at: finite(entry && entry.at), steps: [], model: [], notes: [], error: '', stopped: false, worked: '', replies: 0 };
    turns.push(turn);
  };
  for (const [index, entry] of entries.entries()) {
    if (!entry) continue;
    if (entry.role === 'user' && !entry.steer) { open(entry, index); continue; }
    if (!turn) open({ content: '', at: null }, index);
    if (entry.role === 'assistant') {
      if (String(entry.content || '').trim()) turn.replies++;
      for (const tool of Array.isArray(entry.tools) ? entry.tools : []) {
        if (!tool) continue;
        turn.steps.push({ tool, entryIndex: index });
      }
    } else if (entry.role === 'error') turn.error = String(entry.content || '');
    else if (entry.role === 'worked') {
      turn.worked = String(entry.content || '');
      turn.model.push(...modelSpans(entry.timings));
    } else if (entry.role === 'note') {
      if (String(entry.content || '').trim() === 'Stopped.') turn.stopped = true;
      else turn.notes.push(String(entry.content || ''));
    }
  }
  const last = turns.at(-1);
  if (running && last && timings.length) last.model.push(...modelSpans(timings));
  for (const item of turns) finishTurn(item, { now, running: running && item === last });
  const totals = {
    turns: turns.length,
    steps: turns.reduce((sum, item) => sum + item.stats.steps, 0),
    failed: turns.reduce((sum, item) => sum + item.stats.failed, 0),
    files: new Set(turns.flatMap((item) => item.files)).size,
    durationMs: turns.reduce((sum, item) => sum + (item.durationMs || 0), 0)
  };
  return { turns, totals };
}

function finishTurn(turn, { now, running }) {
  const rows = [];
  for (const { tool, entryIndex } of turn.steps) {
    const span = stepSpan(tool, now);
    const outcome = stepOutcome(tool);
    rows.push({
      id: String(tool.id || ''),
      name: String(tool.name || ''),
      kind: toolKind(tool.name),
      label: stepLabel(tool),
      target: summarizeArgs(tool.name, tool.args || {}),
      outcome,
      startedAt: span ? span[0] : null,
      endedAt: span ? span[1] : null,
      durationMs: span ? span[1] - span[0] : (Number.isFinite(Number(tool.durationMs)) ? Number(tool.durationMs) : null),
      waitedMs: waitedMs(tool, span, now),
      entryIndex,
      tool
    });
  }
  const starts = [turn.at, ...rows.map((row) => row.startedAt), ...turn.model.map((span) => span.startedAt)].filter((value) => value !== null);
  const ends = [...rows.map((row) => row.endedAt), ...turn.model.map((span) => span.endedAt)].filter((value) => value !== null);
  const startedAt = starts.length ? Math.min(...starts) : null;
  let endedAt = ends.length ? Math.max(...ends) : startedAt;
  if (running) endedAt = Math.max(endedAt || 0, now);
  const spanMs = startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : 0;
  const place = (start, end) => {
    if (start === null || startedAt === null || !(spanMs > 0)) return { offset: 0, width: 0 };
    const offset = Math.min(100, Math.max(0, ((start - startedAt) / spanMs) * 100));
    const width = Math.max(0.6, Math.min(100 - offset, (((end ?? start) - start) / spanMs) * 100));
    return { offset, width };
  };
  for (const row of rows) Object.assign(row, place(row.startedAt, row.endedAt));
  for (const span of turn.model) Object.assign(span, place(span.startedAt, span.endedAt));
  const count = (...outcomes) => rows.filter((row) => outcomes.includes(row.outcome)).length;
  const files = [...new Set(rows.filter((row) => EDIT_TOOLS.has(row.name.toLowerCase()) && row.outcome === 'ok').map((row) => stepPath(row.tool.args)).filter(Boolean))];
  turn.steps = rows;
  turn.startedAt = startedAt;
  turn.endedAt = endedAt;
  turn.durationMs = spanMs || null;
  turn.files = files;
  turn.stats = {
    steps: rows.length,
    failed: count('failed', 'timed_out'),
    skipped: count('declined', 'blocked', 'cancelled'),
    running: count('running'),
    edits: rows.filter((row) => row.kind === 'edit').length,
    commands: rows.filter((row) => row.kind === 'shell').length,
    reads: rows.filter((row) => row.kind === 'read' || row.kind === 'search').length,
    modelMs: turn.model.reduce((sum, span) => sum + span.durationMs, 0),
    tokensIn: turn.model.reduce((sum, span) => sum + span.inputTokens, 0),
    tokensOut: turn.model.reduce((sum, span) => sum + span.outputTokens, 0)
  };
  turn.status = running ? 'running' : turn.error ? 'error' : turn.stopped ? 'stopped' : turn.stats.failed ? 'issues' : 'done';
}

export const TRACE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'edit', label: 'Edits' },
  { id: 'shell', label: 'Commands' },
  { id: 'read', label: 'Reads' },
  { id: 'failed', label: 'Failed' }
];

// One step against the panel's filter chip and search box.
export function matchStep(step, { filter = 'all', query = '' } = {}) {
  if (filter === 'failed' && !['failed', 'timed_out'].includes(step.outcome)) return false;
  if (filter === 'edit' && step.kind !== 'edit') return false;
  if (filter === 'shell' && step.kind !== 'shell') return false;
  if (filter === 'read' && !['read', 'search'].includes(step.kind)) return false;
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return true;
  return [step.label, step.target, step.name].some((value) => String(value || '').toLowerCase().includes(needle));
}

const STATUS_WORDS = { running: 'Working', done: 'Done', issues: 'Done with failed steps', error: 'Error', stopped: 'Stopped' };
export function turnStatusLabel(status) { return STATUS_WORDS[status] || 'Done'; }

const OUTCOME_MARK = { ok: 'ok', failed: 'FAILED', timed_out: 'TIMED OUT', declined: 'declined', blocked: 'blocked', cancelled: 'stopped', running: 'running' };

// The trace as Markdown, for pasting into an issue or a review.
export function traceToMarkdown(trace) {
  const lines = ['# OASIS run trace', ''];
  for (const turn of trace.turns) {
    lines.push('## ' + turn.index + '. ' + (turn.prompt.split('\n')[0].slice(0, 120) || '(no message)'));
    lines.push('', turnStatusLabel(turn.status) + ' · ' + turn.stats.steps + ' step' + (turn.stats.steps === 1 ? '' : 's') + (turn.durationMs ? ' · ' + formatDuration(turn.durationMs) : '') + (turn.files.length ? ' · changed ' + turn.files.join(', ') : ''), '');
    for (const step of turn.steps) {
      lines.push('- ' + step.label + (step.target && !step.label.includes(step.target) ? ' — `' + step.target.replace(/`/g, "'") + '`' : '') + ' (' + OUTCOME_MARK[step.outcome] + (step.durationMs !== null ? ', ' + (formatDuration(step.durationMs - step.waitedMs) || '<0.1s') : '') + (step.waitedMs >= 1000 ? ', waited ' + formatDuration(step.waitedMs) + ' for approval' : '') + ')');
    }
    if (turn.error) lines.push('', '> Error: ' + turn.error.split('\n')[0]);
    lines.push('');
  }
  return lines.join('\n').trimEnd() + '\n';
}

const SECRET_KEY = /(api[_-]?key|token|secret|password|passwd|authorization|cookie|credential)/i;
function maskSecrets(args) {
  const out = {};
  for (const [key, value] of Object.entries(args)) out[key] = SECRET_KEY.test(key) ? '[hidden]' : value;
  return out;
}

// The trace as plain data (no DOM refs, no tool output bodies beyond 4 KB).
export function traceToJSON(trace) {
  return {
    version: 1,
    totals: trace.totals,
    turns: trace.turns.map((turn) => ({
      index: turn.index,
      prompt: turn.prompt,
      status: turn.status,
      startedAt: turn.startedAt,
      endedAt: turn.endedAt,
      durationMs: turn.durationMs,
      files: turn.files,
      stats: turn.stats,
      error: turn.error || undefined,
      model: turn.model.map(({ offset, width, ...span }) => span),
      steps: turn.steps.map((step) => ({
        id: step.id,
        name: step.name,
        label: step.label,
        target: step.target,
        outcome: step.outcome,
        startedAt: step.startedAt,
        endedAt: step.endedAt,
        durationMs: step.durationMs,
        waitedMs: step.waitedMs,
        args: maskSecrets(step.tool.args || {}),
        output: String(step.tool.content || '').slice(0, 4096)
      }))
    }))
  };
}
