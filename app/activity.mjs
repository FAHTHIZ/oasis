// Activity panel: the run timeline (tool-call trace) of the open chat.
//
// One section per message you sent; inside it every tool call in order, with
// its outcome, its duration and a bar on the turn's time axis (a waterfall,
// as in a tracing UI), plus a lane for the model's own requests. Filter by
// kind or failures, search, open a step to see its exact input and output,
// jump to it in the conversation, or export the trace as Markdown or JSON.
//
// Rendering is keyed by turn and step id and patched in place, so an open
// step, focus and scroll position survive live updates. The model lives in
// app/core/trace.mjs (pure, unit tested); this file is DOM only.

import { buildTrace, matchStep, TRACE_FILTERS, turnStatusLabel, traceToMarkdown, traceToJSON } from './core/trace.mjs';
import { formatDuration } from './core/timeline.mjs';

const state = { filter: 'all', query: '', open: new Set(), collapsed: new Set(), follow: true, queued: false, deps: null, trace: null, ticker: 0 };
const turnEls = new Map();
const rowEls = new Map();

const $ = (id) => document.getElementById(id);
const el = (tag, className, text) => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const OUTCOME_TEXT = { ok: 'Done', failed: 'Failed', timed_out: 'Timed out', declined: 'Declined', blocked: 'Blocked', cancelled: 'Stopped', running: 'Running' };
const STATUS_CLASS = { ok: 'ok', failed: 'fail', timed_out: 'fail', declined: 'skip', blocked: 'skip', cancelled: 'skip', running: 'running' };

function dur(ms) { return ms === null || ms === undefined ? '' : (formatDuration(ms) || '<0.1s'); }

/**
 * deps: { entries(): display array, running(): boolean, timings(): live model
 * timing records, iconFor(kind): svg string, fillInspector(box, tool),
 * showInChat(id), copyText(text), toast(text), download(name, text) }
 */
export function initActivity(deps) {
  state.deps = deps;
  const filters = $('activityFilters');
  filters.replaceChildren(...TRACE_FILTERS.map((item) => {
    const button = el('button', 'seg-btn', item.label);
    button.type = 'button';
    button.dataset.filter = item.id;
    button.setAttribute('role', 'radio');
    button.setAttribute('aria-checked', String(item.id === state.filter));
    button.addEventListener('click', () => { state.filter = item.id; for (const other of filters.children) other.setAttribute('aria-checked', String(other === button)); render(); });
    return button;
  }));
  $('activitySearch').addEventListener('input', (event) => { state.query = event.target.value; render(); });
  $('activityCopy').addEventListener('click', async () => {
    const ok = await deps.copyText(traceToMarkdown(currentTrace()));
    deps.toast(ok ? 'Trace copied as Markdown.' : 'Could not copy.');
  });
  $('activityDownload').addEventListener('click', () => {
    deps.download('oasis-trace-' + new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.json', JSON.stringify(traceToJSON(currentTrace()), null, 2));
  });
  const list = $('activityList');
  list.addEventListener('scroll', () => { state.follow = list.scrollTop + list.clientHeight >= list.scrollHeight - 24; }, { passive: true });
  list.addEventListener('keydown', onListKey);
  refreshActivity();
}

function currentTrace() {
  const { deps } = state;
  return buildTrace(deps.entries(), { running: deps.running(), timings: deps.timings(), now: Date.now() });
}

function visible() { const view = $('activityView'); return view && !view.hidden && !$('filesPanel').hidden; }

// Call after anything that changes the conversation; coalesced to one frame.
export function refreshActivity() {
  if (!state.deps || state.queued) return;
  state.queued = true;
  requestAnimationFrame(() => { state.queued = false; render(); });
}

// The tab badge: steps in the running turn, or failures in the last one.
function renderBadge(trace) {
  const count = $('activityCount');
  if (!count) return;
  const last = trace.turns.at(-1);
  if (!last) { count.textContent = ''; count.classList.remove('bad'); return; }
  if (last.status === 'running') { count.textContent = String(last.stats.steps || ''); count.classList.remove('bad'); return; }
  count.textContent = last.stats.failed ? String(last.stats.failed) : '';
  count.classList.toggle('bad', Boolean(last.stats.failed));
}

function render() {
  if (!state.deps) return;
  const trace = currentTrace();
  state.trace = trace;
  renderBadge(trace);
  // Keep ticking once a second while a step runs, so bars and clocks move.
  const running = trace.turns.some((turn) => turn.status === 'running');
  if (running && !state.ticker) state.ticker = setInterval(() => { if (visible()) refreshActivity(); }, 1000);
  if (!running && state.ticker) { clearInterval(state.ticker); state.ticker = 0; }
  if (!visible()) return;
  renderSummary(trace);
  const list = $('activityTurns');
  const scroller = $('activityList');
  const empty = $('activityEmpty');
  empty.hidden = trace.turns.some((turn) => turn.steps.length || turn.status === 'running');
  const seenTurns = new Set();
  let anyShown = false;
  for (const [position, turn] of trace.turns.entries()) {
    const key = 'turn:' + turn.entryIndex;
    seenTurns.add(key);
    let node = turnEls.get(key);
    if (!node) { node = turnElement(key); turnEls.set(key, node); }
    // Older turns start folded; the latest stays open unless you fold it.
    const latest = position === trace.turns.length - 1;
    const folded = state.collapsed.has(key) || (!latest && !state.collapsed.has('open:' + key) && !state.query && state.filter === 'all');
    const shown = patchTurn(node, turn, { folded });
    node.hidden = !shown;
    anyShown ||= shown;
    if (node.parentNode !== list || list.children[position] !== node) list.insertBefore(node, list.children[position] || null);
  }
  for (const [key, node] of turnEls) if (!seenTurns.has(key)) { node.remove(); turnEls.delete(key); }
  $('activityNoMatch').hidden = anyShown || !empty.hidden;
  if (state.follow && running) scroller.scrollTop = scroller.scrollHeight;
}

function renderSummary(trace) {
  const box = $('activitySummary');
  const last = trace.turns.at(-1);
  if (!last) { box.hidden = true; return; }
  box.hidden = false;
  box.dataset.status = last.status;
  const parts = [
    ['Steps', String(last.stats.steps)],
    ['Failed', String(last.stats.failed)],
    ['Files', String(last.files.length)],
    ['Time', dur(last.durationMs) || '–']
  ];
  if (last.stats.tokensIn || last.stats.tokensOut) parts.push(['Tokens', compact(last.stats.tokensIn) + ' / ' + compact(last.stats.tokensOut)]);
  const head = el('div', 'activity-summary-head');
  const dot = el('span', 'status-dot');
  dot.setAttribute('aria-hidden', 'true');
  head.append(dot, el('strong', '', turnStatusLabel(last.status)), el('span', 'activity-summary-sub', 'Latest message · ' + trace.totals.turns + ' in this chat'));
  const stats = el('dl', 'activity-stats');
  for (const [label, value] of parts) {
    const cell = el('div', 'activity-stat' + (label === 'Failed' && last.stats.failed ? ' bad' : ''));
    cell.append(el('dt', '', label), el('dd', '', value));
    stats.appendChild(cell);
  }
  box.replaceChildren(head, stats);
}

function compact(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0); }

function turnElement(key) {
  const section = el('section', 'trace-turn');
  section.dataset.key = key;
  const head = el('button', 'trace-turn-head');
  head.type = 'button';
  head.innerHTML = '<span class="trace-chev" aria-hidden="true"></span><span class="trace-turn-index"></span><span class="trace-turn-title"></span><span class="trace-pill"></span><span class="trace-turn-dur"></span>';
  head.addEventListener('click', () => {
    const open = section.classList.contains('folded');
    if (open) { state.collapsed.delete(key); state.collapsed.add('open:' + key); } else { state.collapsed.add(key); state.collapsed.delete('open:' + key); }
    render();
  });
  const body = el('div', 'trace-turn-body');
  const ruler = el('div', 'trace-ruler');
  ruler.setAttribute('aria-hidden', 'true');
  const model = el('div', 'trace-model');
  const rows = el('ol', 'trace-rows');
  const files = el('p', 'trace-files');
  const error = el('p', 'trace-error');
  body.append(ruler, model, rows, files, error);
  section.append(head, body);
  return section;
}

function patchTurn(section, turn, { folded }) {
  const head = section.querySelector('.trace-turn-head');
  head.querySelector('.trace-turn-index').textContent = '#' + turn.index;
  const title = turn.prompt.split('\n')[0].trim() || 'Conversation';
  head.querySelector('.trace-turn-title').textContent = title;
  head.title = turn.prompt.slice(0, 400);
  const pill = head.querySelector('.trace-pill');
  pill.textContent = turn.status === 'running' ? 'Working' : turn.status === 'issues' ? turn.stats.failed + ' failed' : turnStatusLabel(turn.status);
  pill.dataset.status = turn.status;
  head.querySelector('.trace-turn-dur').textContent = [turn.stats.steps + (turn.stats.steps === 1 ? ' step' : ' steps'), dur(turn.durationMs)].filter(Boolean).join(' · ');
  head.setAttribute('aria-expanded', String(!folded));
  section.classList.toggle('folded', folded);
  section.dataset.status = turn.status;
  const steps = turn.steps.filter((step) => matchStep(step, state));
  const filtering = state.filter !== 'all' || state.query.trim();
  if (filtering && !steps.length) return false;
  if (folded) return true;
  // Time ruler: 0, half and the end of the turn.
  const ruler = section.querySelector('.trace-ruler');
  const total = turn.durationMs || 0;
  const axis = el('span', 'trace-axis');
  axis.append(...(total ? [0, 1].map((f) => { const tick = el('span', '', f === 0 ? '0s' : dur(total * f)); tick.style.left = f * 100 + '%'; return tick; }) : []));
  ruler.replaceChildren(axis);
  ruler.hidden = !total;
  // Model lane: one thin bar per model request.
  const model = section.querySelector('.trace-model');
  model.hidden = !turn.model.length;
  const lane = el('span', 'trace-axis');
  lane.append(...turn.model.map((span) => {
    const bar = el('span', 'trace-model-bar');
    bar.style.left = span.offset + '%';
    bar.style.width = span.width + '%';
    bar.title = 'Model request ' + span.step + ': ' + dur(span.durationMs) + (span.ttftMs !== null ? ', first token after ' + dur(span.ttftMs) : '') + (span.inputTokens || span.outputTokens ? ', ' + span.inputTokens + ' in / ' + span.outputTokens + ' out' : '') + (span.toolCalls ? ', asked for ' + span.toolCalls + ' tool call' + (span.toolCalls === 1 ? '' : 's') : '');
    return bar;
  }));
  model.replaceChildren(el('span', 'trace-lane-label', turn.model.length + (turn.model.length === 1 ? ' model request' : ' model requests')), lane);
  const rows = section.querySelector('.trace-rows');
  const wanted = steps.map((step) => rowFor(turn, step));
  const keep = new Set(wanted);
  for (const child of [...rows.children]) if (!keep.has(child)) child.remove();
  wanted.forEach((row, index) => { if (rows.children[index] !== row) rows.insertBefore(row, rows.children[index] || null); });
  const files = section.querySelector('.trace-files');
  files.hidden = !turn.files.length;
  files.textContent = turn.files.length ? 'Changed ' + turn.files.join(', ') : '';
  const error = section.querySelector('.trace-error');
  error.hidden = !turn.error;
  error.textContent = turn.error ? turn.error.split('\n')[0] : '';
  return true;
}

function rowFor(turn, step) {
  const key = turn.entryIndex + ':' + (step.id || step.startedAt);
  let row = rowEls.get(key);
  if (!row) {
    row = el('li', 'trace-row');
    row.dataset.key = key;
    const button = el('button', 'trace-step');
    button.type = 'button';
    button.innerHTML = '<span class="trace-kind" aria-hidden="true"></span><span class="trace-label"></span><span class="trace-target"></span><span class="trace-track" aria-hidden="true"><i></i></span><span class="trace-dur"></span>';
    button.addEventListener('click', () => toggleRow(row));
    const detail = el('div', 'trace-detail');
    detail.hidden = true;
    row.append(button, detail);
    rowEls.set(key, row);
  }
  row._step = step;
  const cls = STATUS_CLASS[step.outcome] || 'ok';
  row.className = 'trace-row ' + cls + ' kind-' + step.kind;
  const button = row.firstChild;
  const kind = button.querySelector('.trace-kind');
  if (kind.dataset.kind !== step.kind) { kind.dataset.kind = step.kind; kind.innerHTML = state.deps.iconFor(step.kind); }
  button.querySelector('.trace-label').textContent = step.label;
  const target = step.target && !step.label.includes(step.target) ? step.target : '';
  button.querySelector('.trace-target').textContent = target;
  const bar = button.querySelector('.trace-track i');
  bar.style.left = step.offset + '%';
  bar.style.width = step.width + '%';
  button.querySelector('.trace-dur').textContent = step.outcome === 'running' ? dur(step.durationMs) || '…' : dur(step.durationMs);
  button.setAttribute('aria-expanded', String(state.open.has(row.dataset.key)));
  button.setAttribute('aria-label', step.label + (target ? ', ' + target : '') + ', ' + OUTCOME_TEXT[step.outcome] + (step.durationMs !== null ? ', ' + dur(step.durationMs) : ''));
  if (state.open.has(row.dataset.key)) fillDetail(row, step);
  return row;
}

function fillDetail(row, step) {
  const detail = row.lastChild;
  // Refill only when the step changed (output arrived, it finished).
  const stamp = [step.outcome, step.tool.content ? step.tool.content.length : 0, step.tool.live ? step.tool.live.length : 0, step.tool.fullContent ? 1 : 0].join(':');
  detail.hidden = false;
  if (detail.dataset.stamp === stamp) return;
  detail.dataset.stamp = stamp;
  const box = el('div', 'inspect');
  state.deps.fillInspector(box, step.tool);
  const actions = el('div', 'trace-actions');
  const meta = el('span', 'trace-meta', [OUTCOME_TEXT[step.outcome], step.startedAt ? 'started ' + new Date(step.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '', step.name].filter(Boolean).join(' · '));
  const jump = el('button', 'btn ghost small', 'Show in chat');
  jump.type = 'button';
  jump.addEventListener('click', () => state.deps.showInChat(step.id));
  actions.append(meta, jump);
  detail.replaceChildren(actions, box);
}

function toggleRow(row) {
  const key = row.dataset.key;
  if (state.open.has(key)) { state.open.delete(key); row.lastChild.hidden = true; row.firstChild.setAttribute('aria-expanded', 'false'); return; }
  state.open.add(key);
  row.firstChild.setAttribute('aria-expanded', 'true');
  fillDetail(row, row._step);
}

// Up and Down move between steps and turn headers; Home and End jump.
function onListKey(event) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  const items = [...$('activityList').querySelectorAll('.trace-turn:not([hidden]) .trace-turn-head, .trace-turn:not([hidden]):not(.folded) .trace-step')];
  if (!items.length) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : event.key === 'ArrowDown' ? Math.min(items.length - 1, index + 1) : Math.max(0, index - 1);
  items[next].focus();
}

// Open the Activity panel on one step (from the conversation).
export function focusStep(id) {
  if (!state.trace) state.trace = currentTrace();
  for (const turn of state.trace.turns) {
    const step = turn.steps.find((item) => item.id === id);
    if (!step) continue;
    const key = 'turn:' + turn.entryIndex;
    state.collapsed.delete(key);
    state.collapsed.add('open:' + key);
    state.filter = 'all';
    state.query = '';
    $('activitySearch').value = '';
    for (const button of $('activityFilters').children) button.setAttribute('aria-checked', String(button.dataset.filter === 'all'));
    const rowKey = turn.entryIndex + ':' + (step.id || step.startedAt);
    state.open.add(rowKey);
    state.follow = false;
    render();
    const row = rowEls.get(rowKey);
    if (row) {
      row.scrollIntoView({ block: 'center' });
      row.classList.add('flash');
      setTimeout(() => row.classList.remove('flash'), 1200);
      row.firstChild.focus({ preventScroll: true });
    }
    return true;
  }
  return false;
}

// A new chat: forget open rows and folds.
export function resetActivity() {
  state.open.clear();
  state.collapsed.clear();
  state.follow = true;
  for (const node of turnEls.values()) node.remove();
  turnEls.clear();
  rowEls.clear();
  refreshActivity();
}
