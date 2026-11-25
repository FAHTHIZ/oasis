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
      // The agents a task step started (the app saves them on its entry).
      if (Array.isArray(entry.subagents) && entry.subagents.length) {
        const task = turn.steps.filter((item) => item.entryIndex === index && String(item.tool.name) === 'task')[0];
        if (task) task.agents = entry.subagents;
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
  // Agents are numbered across the turn: a second task step's agent is 2, not 1 again.
  let agentCount = 0;
  for (const { tool, entryIndex, agents } of turn.steps) {
    const span = stepSpan(tool, now);
    const outcome = stepOutcome(tool);
    const lanes = agentLanes(agents, now, agentCount);
    agentCount += lanes.length;
    rows.push({
      agents: lanes,
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
  for (const row of rows) {
    Object.assign(row, place(row.startedAt, row.endedAt));
    for (const agent of row.agents) {
      // Saved before agents carried times: draw the lane over its task step.
      if (agent.startedAt === null && row.startedAt !== null) { agent.startedAt = row.startedAt; agent.endedAt = row.endedAt; agent.durationMs = null; }
      Object.assign(agent, place(agent.startedAt, agent.endedAt));
      for (const step of agent.steps) Object.assign(step, place(step.startedAt, step.endedAt));
    }
  }
  for (const span of turn.model) Object.assign(span, place(span.startedAt, span.endedAt));
  const count = (...outcomes) => rows.filter((row) => outcomes.includes(row.outcome)).length;
  const agentFiles = rows.flatMap((row) => row.agents.flatMap((agent) => agent.steps.filter((step) => step.kind === 'edit' && step.outcome === 'ok' && step.path && !agent.branch).map((step) => step.path)));
  const files = [...new Set([...rows.filter((row) => EDIT_TOOLS.has(row.name.toLowerCase()) && row.outcome === 'ok').map((row) => stepPath(row.tool.args)), ...agentFiles].filter(Boolean))];
  const agents = rows.flatMap((row) => row.agents);
  turn.steps = rows;
  turn.startedAt = startedAt;
  turn.endedAt = endedAt;
  turn.durationMs = spanMs || null;
  turn.files = files;
  turn.stats = {
    // Plan updates show in the Task plan card, and the chat's "6 steps" skips
    // them; counting them here made the panel say "8 steps" for the same turn.
    steps: rows.filter((row) => !(row.name === 'todo_write' && row.outcome === 'ok')).length,
    failed: count('failed', 'timed_out'),
    skipped: count('declined', 'blocked', 'cancelled'),
    running: count('running'),
    edits: rows.filter((row) => row.kind === 'edit').length,
    commands: rows.filter((row) => row.kind === 'shell').length,
    reads: rows.filter((row) => row.kind === 'read' || row.kind === 'search').length,
    agents: agents.length,
    agentsRunning: agents.filter((agent) => agent.status === 'running').length,
    agentSteps: agents.reduce((sum, agent) => sum + agent.stepCount, 0),
    agentTokens: agents.reduce((sum, agent) => sum + agent.tokens, 0),
    modelMs: turn.model.reduce((sum, span) => sum + span.durationMs, 0),
    tokensIn: turn.model.reduce((sum, span) => sum + span.inputTokens, 0),
    tokensOut: turn.model.reduce((sum, span) => sum + span.outputTokens, 0)
  };
  turn.status = running ? 'running' : turn.error ? 'error' : turn.stopped ? 'stopped' : turn.stats.failed ? 'issues' : 'done';
  turn.now = running ? nowLines(turn, now) : [];
}

const AGENT_DONE = new Set(['completed', 'failed', 'cancelled', 'interrupted']);
const AGENT_OUTCOME = { completed: 'ok', failed: 'failed', cancelled: 'cancelled', interrupted: 'cancelled' };

// "tokens 8,218, requests 2" or "8.2k tokens" -> 8218 / 8200.
export function budgetTokens(text) {
  const raw = String(text || '');
  let match = raw.match(/tokens\s+([\d,.]+)\s*([km])?/i) || raw.match(/([\d,.]+)\s*([km])?\s+tokens/i);
  if (!match) return 0;
  const value = Number(match[1].replace(/,/g, '')) * (/k/i.test(match[2] || '') ? 1e3 : /m/i.test(match[2] || '') ? 1e6 : 1);
  return Number.isFinite(value) ? Math.round(value) : 0;
}

// One lane per agent a task step started: its span, status and own steps.
export function agentLanes(workers, now = Date.now(), offset = 0) {
  if (!Array.isArray(workers)) return [];
  return workers.filter(Boolean).map((worker, index) => {
    const done = AGENT_DONE.has(worker.status);
    const log = Array.isArray(worker.log) ? worker.log : [];
    const startedAt = finite(worker.startedAt) ?? finite(log[0] && log[0].startedAt);
    let endedAt = finite(worker.endedAt);
    if (endedAt === null) endedAt = done ? (finite(log.at(-1) && (log.at(-1).endedAt || log.at(-1).startedAt)) ?? startedAt) : (startedAt === null ? null : now);
    const steps = log.map((item) => {
      const start = finite(item.startedAt);
      const end = finite(item.endedAt) ?? (done ? start : now);
      const outcome = item.endedAt ? (item.ok === false ? (item.outcome === 'declined' || item.outcome === 'blocked' ? item.outcome : 'failed') : 'ok') : done ? 'cancelled' : 'running';
      return { label: String(item.label || item.name || 'Step'), name: String(item.name || ''), kind: toolKind(item.name || ''), path: String(item.path || '').replaceAll(String.fromCharCode(92), '/'), startedAt: start, endedAt: end, durationMs: start !== null && end !== null ? Math.max(0, end - start) : null, outcome, lines: item.lines || null, brief: String(item.brief || '') };
    });
    const detail = String(worker.detail || '');
    return {
      id: String(worker.id || 'agent_' + (index + 1)),
      index: offset + index + 1,
      description: String(worker.description || worker.id || 'Agent ' + (offset + index + 1)),
      status: String(worker.status || 'unknown'),
      outcome: AGENT_OUTCOME[worker.status] || (worker.waitingApproval ? 'waiting' : 'running'),
      waiting: Boolean(worker.waitingApproval),
      activity: done ? '' : String(worker.activity || ''),
      // When the current state began (queued, retrying, between steps).
      activityAt: done ? null : finite(worker.activityAt),
      waitingAt: finite(worker.waitingAt),
      detail,
      branch: (detail.match(/Changes on branch (\S+) \(not merged yet\)/) || [])[1] || '',
      budget: String(worker.budget || ''),
      tokens: budgetTokens(worker.budget),
      startedAt, endedAt,
      durationMs: startedAt !== null && endedAt !== null ? Math.max(0, endedAt - startedAt) : null,
      // Finished steps as the chat card counts them (some have no start label).
      stepCount: Math.max(steps.length, Number(worker.steps) || 0),
      steps
    };
  });
}

// What is happening right now, one line per actor, for the panel's live strip.
function nowLines(turn, now) {
  const lines = [];
  for (const step of turn.steps) {
    if (step.outcome !== 'running') continue;
    if (step.agents.length) {
      for (const agent of step.agents) {
        if (agent.outcome !== 'running' && agent.outcome !== 'waiting') continue;
        const current = agent.steps.filter((item) => item.outcome === 'running').at(-1);
        lines.push({ who: agent.description, agent: agent.index, text: agent.waiting ? 'Waiting for you to approve a step' : current ? current.label : agent.activity || 'Thinking', since: (agent.waiting && agent.waitingAt) || (current && current.startedAt) || agent.activityAt || agent.startedAt, waiting: agent.waiting });
      }
      if (!lines.length) lines.push({ who: 'OASIS', text: step.label, since: step.startedAt });
      continue;
    }
    lines.push({ who: 'OASIS', text: step.tool.waiting ? 'Waiting for you to approve: ' + step.label : step.label, since: step.startedAt, waiting: Boolean(step.tool.waiting) });
  }
  if (!lines.length) {
    const last = turn.steps.filter((step) => step.endedAt !== null).map((step) => step.endedAt);
    lines.push({ who: 'OASIS', text: turn.steps.length ? 'Thinking about the next step' : 'Reading your message', since: last.length ? Math.max(...last) : turn.startedAt, thinking: true });
  }
  return lines;
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
  return [step.label, step.target, step.name, ...(step.agents || []).flatMap((agent) => [agent.description, ...agent.steps.map((item) => item.label)])].some((value) => String(value || '').toLowerCase().includes(needle));
}

const STATUS_WORDS = { running: 'Working', done: 'Done', issues: 'Done with failed steps', error: 'Error', stopped: 'Stopped' };
export function turnStatusLabel(status) { return STATUS_WORDS[status] || 'Done'; }

const AGENT_WORDS = { running: 'working', completed: 'done', failed: 'failed', cancelled: 'stopped', interrupted: 'interrupted', stopping: 'stopping' };
const OUTCOME_MARK = { waiting: 'waiting', ok: 'ok', failed: 'FAILED', timed_out: 'TIMED OUT', declined: 'declined', blocked: 'blocked', cancelled: 'stopped', running: 'running' };

// The trace as Markdown, for pasting into an issue or a review.
export function traceToMarkdown(trace) {
  const lines = ['# OASIS run trace', ''];
  for (const turn of trace.turns) {
    lines.push('## ' + turn.index + '. ' + (turn.prompt.split('\n')[0].slice(0, 120) || '(no message)'));
    lines.push('', turnStatusLabel(turn.status) + ' · ' + turn.stats.steps + ' step' + (turn.stats.steps === 1 ? '' : 's') + (turn.durationMs ? ' · ' + formatDuration(turn.durationMs) : '') + (turn.files.length ? ' · changed ' + turn.files.join(', ') : ''), '');
    for (const step of turn.steps) {
      lines.push('- ' + step.label + (step.target && !step.label.includes(step.target) ? ' — `' + step.target.replace(/`/g, "'") + '`' : '') + ' (' + OUTCOME_MARK[step.outcome] + (step.durationMs !== null ? ', ' + (formatDuration(step.durationMs - step.waitedMs) || '<0.1s') : '') + (step.waitedMs >= 1000 ? ', waited ' + formatDuration(step.waitedMs) + ' for approval' : '') + ')');
      for (const agent of step.agents || []) {
        lines.push('  - Agent ' + agent.index + ': ' + agent.description + ' (' + (AGENT_WORDS[agent.status] || agent.status) + (agent.durationMs ? ', ' + formatDuration(agent.durationMs) : '') + (agent.budget ? ', ' + agent.budget : '') + ')');
        for (const item of agent.steps) lines.push('    - ' + item.label + ' (' + OUTCOME_MARK[item.outcome] + (item.durationMs !== null ? ', ' + (formatDuration(item.durationMs) || '<0.1s') : '') + ')');
        if (agent.branch) lines.push('    - Changes on branch ' + agent.branch + ', not merged yet');
      }
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
        output: String(step.tool.content || '').slice(0, 4096),
        ...(step.agents && step.agents.length ? { agents: step.agents.map(({ offset, width, steps, ...agent }) => ({ ...agent, steps: steps.map(({ offset: _o, width: _w, ...item }) => item) })) } : {})
      }))
    }))
  };
}
