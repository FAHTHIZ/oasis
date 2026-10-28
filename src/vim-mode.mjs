// Vim editing for the prompt editor, matching Claude Code's /vim mode.
//
// Pure functions over the line editor's state ({ text, cursor, undo, history, ... }).
// state.vim = { mode: 'insert' | 'normal', pending, count, register, lastChange, find }
//
// NORMAL mode supports:
//   motions      h l j k  w b e  W B E  0 ^ $  gg G  f F t T {char}  ; ,
//   operators    d c y + motion, dd cc yy, D C Y, x X s S, r{char}, ~, J
//   text objects iw aw iW aW  i" a" i' a' i` a`  i( a( ib ab  i[ a[  i{ a{ iB aB  i< a<
//   insert       i a I A o O
//   other        p P u  . (repeat last change)  counts (3w, d2w, 2dd)
// Enter submits from either mode. j/k on the first/last line walk input history.

const WORD = /[A-Za-z0-9_\u00c0-\uffff]/;

export function createVimState(mode = 'insert') {
  return { mode, pending: '', count: '', register: { text: '', linewise: false }, lastChange: null, find: null };
}

export function vimModeLabel(state) {
  if (!state || !state.vim) return '';
  return state.vim.mode === 'normal' ? '-- NORMAL --' : '-- INSERT --';
}

function lineBounds(text, cursor) {
  const start = text.lastIndexOf('\n', cursor - 1) + 1;
  let end = text.indexOf('\n', cursor);
  if (end === -1) end = text.length;
  return { start, end };
}

function edit(state, text, cursor) {
  const undo = text !== state.text ? [...(state.undo || []).slice(-49), { text: state.text, cursor: state.cursor }] : state.undo || [];
  return { ...state, text, cursor: Math.max(0, Math.min(cursor, text.length)), undo };
}

// In NORMAL mode the cursor sits on a character, never past the end of a line.
function clampNormal(state) {
  const { start, end } = lineBounds(state.text, state.cursor);
  const max = end > start ? end - 1 : start;
  return { ...state, cursor: Math.max(start, Math.min(state.cursor, max)) };
}

const kind = (ch, big) => (ch === undefined ? -1 : /\s/.test(ch) ? 0 : big ? 1 : WORD.test(ch) ? 1 : 2);

function nextWordStart(text, i, big) {
  const n = text.length;
  if (i >= n) return n;
  const k = kind(text[i], big);
  if (k !== 0) while (i < n && kind(text[i], big) === k) i++;
  while (i < n && kind(text[i], big) === 0) i++;
  return i;
}
function prevWordStart(text, i, big) {
  if (i <= 0) return 0;
  i--;
  while (i > 0 && kind(text[i], big) === 0) i--;
  const k = kind(text[i], big);
  while (i > 0 && kind(text[i - 1], big) === k) i--;
  return i;
}
function wordEnd(text, i, big) {
  const n = text.length;
  if (i >= n - 1) return Math.max(0, n - 1);
  i++;
  while (i < n && kind(text[i], big) === 0) i++;
  const k = kind(text[i], big);
  while (i < n - 1 && kind(text[i + 1], big) === k) i++;
  return i;
}

function findChar(text, cursor, find, reverse = false) {
  const { start, end } = lineBounds(text, cursor);
  const forward = (find.cmd === 'f' || find.cmd === 't') !== reverse;
  const till = find.cmd === 't' || find.cmd === 'T';
  if (forward) {
    const from = cursor + 1;
    const at = text.indexOf(find.char, from);
    if (at === -1 || at >= end) return null;
    return till ? at - 1 : at;
  }
  const from = cursor - 1;
  if (from < start) return null;
  const at = text.lastIndexOf(find.char, from);
  if (at === -1 || at < start) return null;
  return till ? at + 1 : at;
}

// Returns { to, inclusive, linewise } for a motion, or null when it cannot move.
function motion(state, key, count) {
  const { text, cursor } = state;
  let to = cursor;
  const repeat = (fn) => { for (let i = 0; i < count; i++) to = fn(to); };
  switch (key) {
    case 'h': { const { start } = lineBounds(text, cursor); to = Math.max(start, cursor - count); return { to }; }
    case 'l': { const { end } = lineBounds(text, cursor); to = Math.min(end, cursor + count); return { to }; }
    case 'w': repeat((i) => nextWordStart(text, i, false)); return { to };
    case 'W': repeat((i) => nextWordStart(text, i, true)); return { to };
    case 'b': repeat((i) => prevWordStart(text, i, false)); return { to };
    case 'B': repeat((i) => prevWordStart(text, i, true)); return { to };
    case 'e': repeat((i) => wordEnd(text, i, false)); return { to, inclusive: true };
    case 'E': repeat((i) => wordEnd(text, i, true)); return { to, inclusive: true };
    case '0': return { to: lineBounds(text, cursor).start };
    case '^': { const { start, end } = lineBounds(text, cursor); let i = start; while (i < end && /[ \t]/.test(text[i])) i++; return { to: i }; }
    case '$': { const { end } = lineBounds(text, cursor); return { to: end, inclusive: false, toEnd: true }; }
    case 'gg': return { to: 0, linewise: true };
    case 'G': return { to: text.length, linewise: true };
    case 'j':
    case 'k': {
      let pos = cursor;
      for (let i = 0; i < count; i++) {
        const { start, end } = lineBounds(text, pos);
        const column = pos - start;
        if (key === 'j') {
          if (end >= text.length) return i ? { to: pos, linewise: true } : null;
          const next = lineBounds(text, end + 1);
          pos = Math.min(next.start + column, next.end);
        } else {
          if (start === 0) return i ? { to: pos, linewise: true } : null;
          const prev = lineBounds(text, start - 1);
          pos = Math.min(prev.start + column, prev.end);
        }
      }
      return { to: pos, linewise: true };
    }
    default: return null;
  }
}

const PAIRS = { '(': ['(', ')'], ')': ['(', ')'], b: ['(', ')'], '[': ['[', ']'], ']': ['[', ']'], '{': ['{', '}'], '}': ['{', '}'], B: ['{', '}'], '<': ['<', '>'], '>': ['<', '>'] };

// Text objects: iw aw iW aW, quotes, brackets. Returns { from, to } (exclusive end) or null.
function textObject(text, cursor, scope, object) {
  if (object === 'w' || object === 'W') {
    const big = object === 'W';
    if (!text.length) return null;
    const at = Math.min(cursor, text.length - 1);
    const k = kind(text[at], big);
    let from = at;
    let to = at + 1;
    while (from > 0 && kind(text[from - 1], big) === k && text[from - 1] !== '\n') from--;
    while (to < text.length && kind(text[to], big) === k && text[to] !== '\n') to++;
    if (scope === 'a') {
      let extended = to;
      while (extended < text.length && /[ \t]/.test(text[extended])) extended++;
      if (extended > to) to = extended;
      else while (from > 0 && /[ \t]/.test(text[from - 1])) from--;
    }
    return { from, to };
  }
  if (object === '"' || object === "'" || object === '`') {
    const { start, end } = lineBounds(text, cursor);
    const line = text.slice(start, end);
    const quotes = [];
    for (let i = 0; i < line.length; i++) if (line[i] === object && line[i - 1] !== '\\') quotes.push(start + i);
    // The first adjacent pair around the cursor (or the first pair after it).
    for (let i = 0; i + 1 < quotes.length; i++) {
      const open = quotes[i];
      const close = quotes[i + 1];
      if (cursor <= close && (cursor >= open || i === 0)) {
        return scope === 'i' ? { from: open + 1, to: close } : { from: open, to: close + 1 };
      }
    }
    return null;
  }
  const pair = PAIRS[object];
  if (!pair) return null;
  const [openCh, closeCh] = pair;
  let depth = 0;
  let open = -1;
  for (let i = Math.min(cursor, text.length - 1); i >= 0; i--) {
    if (text[i] === closeCh && i !== cursor) depth++;
    else if (text[i] === openCh) { if (depth === 0) { open = i; break; } depth--; }
  }
  if (open < 0) return null;
  depth = 0;
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === openCh) depth++;
    else if (text[i] === closeCh) {
      if (depth === 0) return scope === 'i' ? { from: open + 1, to: i } : { from: open, to: i + 1 };
      depth--;
    }
  }
  return null;
}

function linewiseRange(text, a, b) {
  const first = lineBounds(text, Math.min(a, b));
  const last = lineBounds(text, Math.max(a, b));
  let from = first.start;
  let to = last.end;
  if (to < text.length) to += 1; // eat the newline after the last line
  else if (from > 0) from -= 1; // or the one before the first line
  return { from, to };
}

function withVim(state, patch) { return { ...state, vim: { ...state.vim, ...patch } }; }

function enterInsert(state, cursor = state.cursor) {
  return withVim({ ...state, cursor }, { mode: 'insert', pending: '', count: '' });
}

function applyOperator(state, op, from, to, options = {}) {
  const { text } = state;
  if (from > to) [from, to] = [to, from];
  const removed = text.slice(from, to);
  const register = { text: removed, linewise: Boolean(options.linewise) };
  if (op === 'y') return { state: clampNormal(withVim({ ...state, cursor: options.linewise ? lineBounds(text, from).start : from }, { register, pending: '', count: '' })) };
  let next = edit(state, text.slice(0, from) + text.slice(to), from);
  next = withVim(next, { register, pending: '', count: '' });
  if (op === 'c') {
    if (options.linewise) {
      // cc keeps an empty line to type into.
      const keepNewline = removed.endsWith('\n') ? '\n' : removed.startsWith('\n') ? '\n' : '';
      const insertAt = removed.startsWith('\n') && !removed.endsWith('\n') ? from + 1 : from;
      next = edit(next, next.text.slice(0, from) + keepNewline + next.text.slice(from), insertAt);
      next = { ...next, undo: next.undo.slice(0, -1) };
    }
    return { state: enterInsert(next) };
  }
  if (options.linewise) {
    const { start } = lineBounds(next.text, Math.min(from, next.text.length));
    next = { ...next, cursor: start };
  }
  return { state: clampNormal(next) };
}

function put(state, after, count) {
  const { register } = state.vim;
  if (!register.text) return { state, action: 'bell' };
  const { text, cursor } = state;
  const chunk = register.text.repeat(count);
  if (register.linewise) {
    const body = chunk.endsWith('\n') ? chunk : chunk + '\n';
    const { start, end } = lineBounds(text, cursor);
    if (after) {
      const at = end;
      const insert = '\n' + body.replace(/\n$/, '');
      return { state: clampNormal(edit(state, text.slice(0, at) + insert + text.slice(at), at + 1)) };
    }
    return { state: clampNormal(edit(state, text.slice(0, start) + body + text.slice(start), start)) };
  }
  const at = after && text.length ? Math.min(cursor + 1, lineBounds(text, cursor).end) : cursor;
  return { state: clampNormal(edit(state, text.slice(0, at) + chunk + text.slice(at), at + chunk.length - 1)) };
}

function historyMove(state, delta) {
  const index = state.historyIndex + delta;
  if (index < 0 || index > state.history.length) return { state, action: 'bell' };
  const draft = state.historyIndex === state.history.length ? state.text : state.draft;
  const value = index === state.history.length ? draft : state.history[index];
  return { state: clampNormal({ ...state, historyIndex: index, draft, text: value, cursor: 0 }), action: null };
}

/**
 * Applies one decoded key in vim mode. Returns { state, action } like applyKey, or
 * null when the key should go to the normal (insert-mode) editor.
 */
export function applyVimKey(state, key) {
  const vim = state.vim;
  if (!vim) return null;
  if (vim.mode === 'insert') {
    if (key.name === 'escape') {
      const { start } = lineBounds(state.text, state.cursor);
      const next = withVim({ ...state, cursor: state.cursor > start ? state.cursor - 1 : state.cursor }, { mode: 'normal', pending: '', count: '' });
      return { state: clampNormal(next), action: null };
    }
    return null;
  }
  // NORMAL mode.
  if (key.name === 'enter') return { state, action: 'submit' };
  if (key.name === 'escape') {
    if (vim.pending || vim.count) return { state: withVim(state, { pending: '', count: '' }), action: null };
    return { state, action: 'escape' };
  }
  if (key.name === 'paste') return { state: clampNormal(edit(state, state.text.slice(0, state.cursor) + key.text + state.text.slice(state.cursor), state.cursor + key.text.length)), action: null };
  if (key.name === 'left') return applyVimKey(state, { name: 'char', text: 'h' });
  if (key.name === 'right') return applyVimKey(state, { name: 'char', text: 'l' });
  if (key.name === 'up') return applyVimKey(state, { name: 'char', text: 'k' });
  if (key.name === 'down') return applyVimKey(state, { name: 'char', text: 'j' });
  if (key.name === 'home') return applyVimKey(state, { name: 'char', text: '0' });
  if (key.name === 'end') return applyVimKey(state, { name: 'char', text: '$' });
  if (key.name === 'backspace') return applyVimKey(state, { name: 'char', text: 'h' });
  if (key.name !== 'char') return null; // Ctrl keys, Tab, Shift+Tab keep their usual meaning.
  let current = state;
  let action = null;
  for (const ch of key.text) {
    const result = normalChar(current, ch);
    current = result.state;
    if (result.action) action = result.action;
  }
  return { state: current, action };
}

function normalChar(state, ch) {
  const vim = state.vim;
  const pending = vim.pending;
  // Characters awaited by f/F/t/T and r.
  if (/^[dcy]?[fFtT]$/.test(pending)) {
    const op = pending.length === 2 ? pending[0] : '';
    const find = { cmd: pending[pending.length - 1], char: ch };
    const count = Number(vim.count || 1);
    let to = state.cursor;
    for (let i = 0; i < count; i++) { const at = findChar(state.text, to, find); if (at === null) { to = null; break; } to = at; }
    const next = withVim(state, { pending: '', count: '', find });
    if (to === null) return { state: next, action: 'bell' };
    if (!op) return { state: clampNormal({ ...next, cursor: to }) };
    const change = { keys: (vim.count || '') + pending + ch };
    const forward = to >= state.cursor;
    return record(applyOperator(next, op, forward ? state.cursor : to, forward ? to + 1 : state.cursor), change);
  }
  if (pending === 'r') {
    const count = Number(vim.count || 1);
    const { end } = lineBounds(state.text, state.cursor);
    if (state.cursor + count > end) return { state: withVim(state, { pending: '', count: '' }), action: 'bell' };
    const text = state.text.slice(0, state.cursor) + ch.repeat(count) + state.text.slice(state.cursor + count);
    return record({ state: withVim(edit(state, text, state.cursor + count - 1), { pending: '', count: '' }) }, { keys: (vim.count || '') + 'r' + ch });
  }
  if (/^[dcy][ia]$/.test(pending)) {
    const range = textObject(state.text, state.cursor, pending[1], ch);
    const next = withVim(state, { pending: '', count: '' });
    if (!range) return { state: next, action: 'bell' };
    return record(applyOperator(next, pending[0], range.from, range.to), { keys: pending + ch });
  }
  // Counts.
  if (/[1-9]/.test(ch) || (ch === '0' && vim.count)) return { state: withVim(state, { count: vim.count + ch }) };
  const count = Number(vim.count || 1);
  const operator = /^[dcy]$/.test(pending) ? pending : '';
  if (pending === 'g' || pending === 'dg' || pending === 'cg' || pending === 'yg') {
    if (ch !== 'g') return { state: withVim(state, { pending: '', count: '' }), action: 'bell' };
    const op = pending.length === 2 ? pending[0] : '';
    const next = withVim(state, { pending: '', count: '' });
    if (!op) return { state: clampNormal({ ...next, cursor: 0 }) };
    return record(applyOperator(next, op, 0, lineBounds(state.text, state.cursor).end < state.text.length ? lineBounds(state.text, state.cursor).end + 1 : state.text.length, { linewise: true }), { keys: pending + 'g' });
  }
  if (operator) {
    // dd / cc / yy (with count): whole lines.
    if (ch === operator) {
      let last = state.cursor;
      for (let i = 1; i < count; i++) { const { end } = lineBounds(state.text, last); if (end >= state.text.length) break; last = end + 1; }
      const range = linewiseRange(state.text, state.cursor, last);
      return record(applyOperator(withVim(state, { pending: '', count: '' }), operator, range.from, range.to, { linewise: true }), { keys: (vim.count || '') + operator + ch });
    }
    if (ch === 'i' || ch === 'a') return { state: withVim(state, { pending: operator + ch }) };
    if ('fFtT'.includes(ch)) return { state: withVim(state, { pending: operator + ch }) };
    if (ch === 'g') return { state: withVim(state, { pending: operator + 'g' }) };
    // cw behaves like ce (vim's special case).
    const motionKey = operator === 'c' && (ch === 'w' || ch === 'W') && state.text[state.cursor] && !/\s/.test(state.text[state.cursor]) ? (ch === 'w' ? 'e' : 'E') : ch;
    const m = motion(state, motionKey, count);
    const next = withVim(state, { pending: '', count: '' });
    if (!m) return { state: next, action: 'bell' };
    const change = { keys: (vim.count || '') + operator + ch };
    if (m.linewise) { const range = linewiseRange(state.text, state.cursor, m.to); return record(applyOperator(next, operator, range.from, range.to, { linewise: true }), change); }
    let to = m.to;
    if (m.inclusive) to += 1;
    // dw at the end of a line stops at the newline.
    if ((ch === 'w' || ch === 'W') && operator !== 'c') { const { end } = lineBounds(state.text, state.cursor); if (to > end && state.cursor < end) to = end; }
    return record(applyOperator(next, operator, state.cursor, to), change);
  }
  const reset = (s) => withVim(s, { pending: '', count: '' });
  const { text, cursor } = state;
  switch (ch) {
    case 'i': return record({ state: enterInsert(state) }, { keys: 'i' });
    case 'a': return record({ state: enterInsert(state, Math.min(cursor + (text.length && text[cursor] !== '\n' ? 1 : 0), lineBounds(text, cursor).end)) }, { keys: 'a' });
    case 'I': { const m = motion(state, '^', 1); return record({ state: enterInsert(state, m.to) }, { keys: 'I' }); }
    case 'A': return record({ state: enterInsert(state, lineBounds(text, cursor).end) }, { keys: 'A' });
    case 'o': { const { end } = lineBounds(text, cursor); return record({ state: enterInsert(edit(state, text.slice(0, end) + '\n' + text.slice(end), end + 1)) }, { keys: 'o', insert: true }); }
    case 'O': { const { start } = lineBounds(text, cursor); return record({ state: enterInsert(edit(state, text.slice(0, start) + '\n' + text.slice(start), start)) }, { keys: 'O', insert: true }); }
    case 'd': case 'c': case 'y': return { state: withVim(state, { pending: ch }) };
    case 'g': return { state: withVim(state, { pending: 'g' }) };
    case 'f': case 'F': case 't': case 'T': return { state: withVim(state, { pending: ch }) };
    case 'r': return { state: withVim(state, { pending: 'r' }) };
    case ';': case ',': {
      if (!vim.find) return { state: reset(state), action: 'bell' };
      let to = cursor;
      for (let i = 0; i < count; i++) {
        let at = findChar(text, to, vim.find, ch === ',');
        // t/T next to the target would not move; look one further, like vim.
        if (at === to && /[tT]/.test(vim.find.cmd)) at = findChar(text, (vim.find.cmd === 't') === (ch === ';') ? to + 1 : to - 1, vim.find, ch === ',');
        if (at === null) break;
        to = at;
      }
      return { state: clampNormal(reset({ ...state, cursor: to })) };
    }
    case 'x': { if (!text.length || text[cursor] === '\n') return { state: reset(state), action: 'bell' }; const { end } = lineBounds(text, cursor); return record(applyOperator(reset(state), 'd', cursor, Math.min(end, cursor + count)), { keys: (vim.count || '') + 'x' }); }
    case 'X': { const { start } = lineBounds(text, cursor); if (cursor === start) return { state: reset(state), action: 'bell' }; return record(applyOperator(reset(state), 'd', Math.max(start, cursor - count), cursor), { keys: (vim.count || '') + 'X' }); }
    case 's': { const { end } = lineBounds(text, cursor); return record(applyOperator(reset(state), 'c', cursor, Math.min(end, cursor + count)), { keys: 's', insert: true }); }
    case 'S': { const { start, end } = lineBounds(text, cursor); return record(applyOperator(reset(state), 'c', start, end), { keys: 'S', insert: true }); }
    case 'D': return record(applyOperator(reset(state), 'd', cursor, lineBounds(text, cursor).end), { keys: 'D' });
    case 'C': return record(applyOperator(reset(state), 'c', cursor, lineBounds(text, cursor).end), { keys: 'C', insert: true });
    case 'Y': { const range = linewiseRange(text, cursor, cursor); return applyOperator(reset(state), 'y', range.from, range.to, { linewise: true }); }
    case '~': {
      const { end } = lineBounds(text, cursor);
      const stop = Math.min(end, cursor + count);
      const swapped = [...text.slice(cursor, stop)].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('');
      return record({ state: clampNormal(reset(edit(state, text.slice(0, cursor) + swapped + text.slice(stop), stop))) }, { keys: (vim.count || '') + '~' });
    }
    case 'J': {
      const { end } = lineBounds(text, cursor);
      if (end >= text.length) return { state: reset(state), action: 'bell' };
      let after = end + 1;
      while (after < text.length && /[ \t]/.test(text[after])) after++;
      return record({ state: clampNormal(reset(edit(state, text.slice(0, end) + ' ' + text.slice(after), end))) }, { keys: 'J' });
    }
    case 'p': case 'P': return put(reset(state), ch === 'p', count);
    case 'u': {
      const last = (state.undo || [])[state.undo.length - 1];
      if (!last) return { state: reset(state), action: 'bell' };
      return { state: clampNormal(reset({ ...state, text: last.text, cursor: last.cursor, undo: state.undo.slice(0, -1) })) };
    }
    case '.': {
      const change = vim.lastChange;
      if (!change) return { state: reset(state), action: 'bell' };
      let next = reset(state);
      for (let i = 0; i < (vim.count ? count : 1); i++) {
        for (const c of change.keys) next = normalChar(next, c).state;
        if (change.typed !== undefined && next.vim.mode === 'insert') {
          next = edit(next, next.text.slice(0, next.cursor) + change.typed + next.text.slice(next.cursor), next.cursor + change.typed.length);
          next = clampNormal(withVim({ ...next, cursor: Math.max(lineBounds(next.text, next.cursor).start, next.cursor - 1) }, { mode: 'normal' }));
        }
      }
      return { state: withVim(next, { lastChange: change }) };
    }
    case 'j': case 'k': {
      const m = motion(state, ch, count);
      if (!m) return historyMove(reset(state), ch === 'k' ? -1 : 1);
      return { state: clampNormal(reset({ ...state, cursor: m.to })) };
    }
    default: {
      const m = motion(state, ch, count);
      if (!m) return { state: reset(state), action: null };
      return { state: clampNormal(reset({ ...state, cursor: m.to })) };
    }
  }
}

// Remembers the last change for "."; changes that enter INSERT record what gets typed.
function record(result, change) {
  const vim = result.state.vim;
  const lastChange = { keys: change.keys, ...(vim.mode === 'insert' ? { typed: '', insertStart: result.state.cursor } : {}) };
  return { ...result, state: withVim(result.state, { lastChange }) };
}

/** Called for INSERT-mode edits so "." can replay the text typed after c/s/o. */
export function trackInsert(before, after) {
  if (!after.vim || after.vim.mode !== 'insert' || !after.vim.lastChange || after.vim.lastChange.typed === undefined) return after;
  const change = after.vim.lastChange;
  const start = change.insertStart ?? before.cursor;
  if (after.cursor < start) return after;
  const typed = after.text.slice(start, after.cursor);
  return withVim(after, { lastChange: { ...change, typed } });
}
