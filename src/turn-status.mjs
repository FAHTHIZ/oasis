// The live status for a running turn: one line saying what Oasis is doing
// right now, an optional dim detail row under it (the last line of command
// output, or a one-line glimpse of the model's reasoning), and the task
// checklist. Rows are handed to the live region, which draws them below the
// transcript in one synchronized frame.
//
//   ✻ Writing src/server.mjs · 3.2 KB… (24s · ↓ 1.2k tokens · step 3 · esc to stop)
//     ⎿ I need to read the router before changing the handler
//   ✔ Read the existing routes
//   ◼ Adding the health endpoint
//   ☐ Run the tests
//
// The clock is for the whole turn (it never jumps back to 0s between steps).
// Frames follow the wall clock, so a busy event loop skips frames instead of
// slowing the spinner down.

import { describeDraft } from './tool-draft.mjs';
import { formatElapsed, formatTokens, promptProgressText, shimmer, waitLabel } from './activity-indicator.mjs';

const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const GLYPH_MS = 120;
const SHIMMER_MS = 70;
const LITE_MS = 500;
const MAX_TODOS = 6;

const oneLine = (value, max = 160) => {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
};

// The last complete thought of the reasoning so far, as one short line. A
// finished line counts as a thought even without a full stop, so a numbered
// plan reads "Run the tests", not "first step 2."; list markers, headings and
// link targets are left out.
export function reasoningGlimpse(text) {
  // Only the tail matters, and this runs on every streamed chunk.
  const lines = String(text || '').slice(-4000)
    .replace(/\[([^\]\n]*)\]\([^)\s]*\)/g, '$1')
    .replace(/\*\*|__|`/g, '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)+/, '').replace(/\s+/g, ' ').trim());
  const clean = lines.filter(Boolean).join(' ');
  if (!clean) return '';
  const pieces = [];
  lines.forEach((line, index) => {
    if (!line) return;
    const sentences = line.match(/[^.!?]+[.!?]+(?=\s|$)/g) || [];
    if (index < lines.length - 1) pieces.push(...(sentences.length && sentences.join('').length >= line.length - 1 ? sentences : [line]));
    else pieces.push(...sentences);
  });
  const tail = pieces.length ? pieces.at(-1) : clean.slice(-160);
  return oneLine(tail.replace(/^[#>*\-\s]+/, ''), 140);
}

// Pick at most `max` checklist rows, keeping the active item in view.
export function todoWindow(todos, max = MAX_TODOS) {
  const list = Array.isArray(todos) ? todos.filter((t) => t && t.content) : [];
  if (list.length <= max) return { items: list, before: 0, after: 0 };
  let focus = list.findIndex((t) => t.status === 'in_progress');
  if (focus < 0) focus = list.findIndex((t) => t.status !== 'completed');
  if (focus < 0) focus = list.length - 1;
  let start = Math.max(0, Math.min(focus - 1, list.length - max));
  return { items: list.slice(start, start + max), before: start, after: list.length - start - max };
}

export function describeStatus(info = {}, { turnMs = 0, phaseMs = 0 } = {}) {
  const parts = [formatElapsed(turnMs)];
  let label;
  if (info.phase === 'rate' || Number(info.rateLimitMs) > phaseMs) {
    label = 'Rate limited';
    parts.push('retrying in ' + formatElapsed(Number(info.rateLimitMs) - phaseMs + 999));
  } else if (info.phase === 'draft' && info.draftInfo) {
    const draft = describeDraft(info.draftInfo);
    label = draft.label + (draft.size ? ' · ' + draft.size : '');
  } else if (info.phase === 'tool' || info.phase === 'command') {
    label = info.label || 'Working';
  } else if (info.phase === 'responding') {
    label = 'Responding';
  } else {
    label = waitLabel({ ...info, label: info.label || null }, phaseMs);
    const reading = promptProgressText(info.promptProgress, Number(info.promptProgressAgeMs) || 0);
    if (reading) parts.push(reading);
  }
  if (Number(info.outTokens) > 0) parts.push('↓ ' + formatTokens(info.outTokens) + ' tokens');
  else if (Number(info.inputTokens) > 0 && info.phase === 'thinking') parts.push(formatTokens(info.inputTokens) + ' tokens sent');
  if (Number(info.step) > 1) parts.push('step ' + info.step);
  const typed = String(info.typed || '').replace(/\s+/g, ' ').trim();
  parts.push(typed ? '› ' + (typed.length > 48 ? '…' + typed.slice(-47) : typed) : 'esc to stop');
  return { label: label + '…', meta: parts.join(' · ') };
}

export function createTurnStatus({ region, level = 'full', color = true, now = () => Date.now(), timers = { setInterval, clearInterval } } = {}) {
  let info = {};
  let turnStart = 0;
  let phaseStart = 0;
  let handle = null;
  let progressAt = 0;
  const paint = (code, text) => (color ? code + text + '\x1b[0m' : text);
  const dim = (text) => paint('\x1b[2m', text);

  function statusRows() {
    const t = now();
    const shown = progressAt ? { ...info, promptProgressAgeMs: t - progressAt } : info;
    const { label, meta } = describeStatus(shown, { turnMs: t - turnStart, phaseMs: t - phaseStart });
    let line;
    if (level === 'full') {
      const glyph = GLYPHS[Math.floor((t - turnStart) / GLYPH_MS) % GLYPHS.length];
      const lit = color ? shimmer(label, Math.floor((t - phaseStart) / SHIMMER_MS), { base: '\x1b[36m', highlight: '\x1b[1;96m' }) : label;
      line = paint('\x1b[36m', glyph) + ' ' + lit + ' ' + dim('(' + meta + ')');
    } else {
      const dots = ['·  ', '·· ', '···'][Math.floor((t - turnStart) / LITE_MS) % 3];
      line = paint('\x1b[36m', '*') + ' ' + paint('\x1b[36m', label) + ' ' + dim('(' + meta + ') ' + dots);
    }
    const rows = [line];
    const detail = info.phase === 'command' || info.phase === 'tool' ? oneLine(info.output, 200)
      : info.phase === 'thinking' ? reasoningGlimpse(info.reasoning) : '';
    if (detail) rows.push(dim('  ⎿ ' + detail));
    return rows;
  }

  function todoRows() {
    const { items, before, after } = todoWindow(info.todos);
    if (!items.length) return [];
    const rows = [];
    if (before) rows.push(dim('  … ' + before + ' done'));
    for (const item of items) {
      if (item.status === 'completed') rows.push(dim('  ' + paint('\x1b[32m', '✔') + ' ' + (color ? '\x1b[9m' : '') + oneLine(item.content) + (color ? '\x1b[29m' : '')));
      else if (item.status === 'in_progress') rows.push('  ' + paint('\x1b[36m', '◼') + ' ' + paint('\x1b[1m', oneLine(item.activeForm || item.content)));
      else rows.push(dim('  ☐ ' + oneLine(item.content)));
    }
    if (after) rows.push(dim('  + ' + after + ' more'));
    return rows;
  }

  function render() {
    if (!region || !handle) return;
    region.set('status', statusRows());
    region.set('todos', todoRows());
  }

  const status = {
    get active() { return Boolean(handle); },
    get info() { return { ...info }; },
    start(initial = {}) {
      turnStart = now();
      phaseStart = turnStart;
      info = { phase: 'thinking', outTokens: 0, ...initial };
      if (handle) return;
      handle = timers.setInterval(render, level === 'full' ? Math.min(GLYPH_MS, SHIMMER_MS) : LITE_MS);
      if (handle && typeof handle.unref === 'function') handle.unref();
      render();
    },
    // A new phase restarts the phase clock (the shimmer, the wait label), never the turn clock.
    update(patch = {}) {
      if (patch.promptProgress) progressAt = now();
      const { restart, ...rest } = patch;
      if ((rest.phase && rest.phase !== info.phase) || restart) { phaseStart = now(); progressAt = rest.promptProgress ? progressAt : 0; }
      info = { ...info, ...rest };
      render();
    },
    addTokens(chars) { info.outTokens = Number(info.outTokens || 0) + Math.max(0, Number(chars) || 0) / 4; },
    stop() {
      if (handle) { timers.clearInterval(handle); handle = null; }
      if (region) { region.set('status', []); region.set('todos', []); }
    }
  };
  return status;
}
