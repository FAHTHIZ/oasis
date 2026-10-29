// Interactive prompt editor for the Oasis terminal.
//
// A dependency-free raw-mode line editor: multi-line input, bracketed paste,
// persistent history with Ctrl+R search, Tab completion with a candidate list,
// Shift+Tab mode cycling, word motions, and a footer line for mode/shortcut
// hints. Editing logic is pure (state in, state out) so it can be unit tested
// without a terminal; `readInput` wires it to a TTY.

import { applyVimKey, createVimState, trackInsert, vimModeLabel } from './vim-mode.mjs';
import { loadKeybindings, resolveBinding, actionEffect, CHORD_TIMEOUT_MS, DEFAULT_BINDINGS } from './keybindings.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

const ANSI_PATTERN = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(text) {
  return String(text || '').replace(ANSI_PATTERN, '');
}

export function charWidth(codePoint) {
  const cp = codePoint;
  if (cp < 32 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if ((cp >= 0x300 && cp <= 0x36f) || cp === 0x200b || cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0;
  if ((cp >= 0x1100 && cp <= 0x115f) || (cp >= 0x2e80 && cp <= 0xa4cf) || (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) || (cp >= 0xfe30 && cp <= 0xfe4f) || (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) || (cp >= 0x1f300 && cp <= 0x1f64f) || (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)) return 2;
  return 1;
}

export function stringWidth(text) {
  let width = 0;
  for (const char of stripAnsi(text)) width += charWidth(char.codePointAt(0));
  return width;
}

export function truncateToWidth(text, max) {
  const plain = stripAnsi(text);
  if (stringWidth(plain) <= max) return text;
  let out = '';
  let width = 0;
  for (const char of plain) {
    const w = charWidth(char.codePointAt(0));
    if (width + w > max - 1) break;
    out += char;
    width += w;
  }
  return out + '…';
}

// ---------------------------------------------------------------------------
// Key decoding

const CSI_FINAL = {
  A: 'up', B: 'down', C: 'right', D: 'left', H: 'home', F: 'end', Z: 'shiftTab'
};
const TILDE_KEYS = { 1: 'home', 7: 'home', 4: 'end', 8: 'end', 3: 'delete', 5: 'pageUp', 6: 'pageDown', 2: 'insert' };
const CONTROL_KEYS = {
  '\r': 'enter', '\n': 'newline', '\t': 'tab', '\x7f': 'backspace', '\b': 'backspace',
  '\x01': 'home', '\x05': 'end', '\x02': 'left', '\x06': 'right', '\x10': 'up', '\x0e': 'down',
  '\x0b': 'killEnd', '\x15': 'killStart', '\x17': 'killWord', '\x0c': 'clearScreen', '\x12': 'search',
  '\x03': 'ctrlC', '\x04': 'ctrlD', '\x07': 'ctrlG', '\x16': 'ctrlV', '\x0f': 'ctrlO', '\x14': 'ctrlT',
  '\x19': 'yank', '\x1f': 'undo'
};

// Keystroke names (Claude Code keybindings syntax) for control bytes.
function controlStroke(ch) {
  if (ch === '\r') return 'enter';
  if (ch === '\t') return 'tab';
  if (ch === '\x7f' || ch === '\b') return 'backspace';
  const code = ch.charCodeAt(0);
  if (code >= 1 && code <= 26) return 'ctrl+' + String.fromCharCode(code + 96);
  if (code === 0x1f) return 'ctrl+_';
  if (code === 0x1c) return 'ctrl+\\';
  if (code === 0x1d) return 'ctrl+]';
  if (code === 0x1e) return 'ctrl+^';
  return null;
}
function modifierPrefix(mod) {
  const bits = Math.max(0, Number(mod || 1) - 1);
  return (bits & 4 ? 'ctrl+' : '') + (bits & 2 ? 'meta+' : '') + (bits & 1 ? 'shift+' : '') + (bits & 8 ? 'super+' : '');
}
const SPECIAL_STROKES = { up: 'up', down: 'down', left: 'left', right: 'right', home: 'home', end: 'end', delete: 'delete', pageUp: 'pageup', pageDown: 'pagedown', insert: 'insert' };
function charStroke(ch) {
  if (ch === ' ') return 'space';
  if (/^[A-Z]$/.test(ch)) return 'shift+' + ch.toLowerCase();
  return ch;
}

// Stateful decoder: turns raw terminal input into key events. Bracketed paste
// (ESC[200~ … ESC[201~) is collected into one `paste` event, even across chunks.
export class KeyDecoder {
  constructor() { this.pasting = null; this.pending = ''; }

  feed(chunk) {
    let data = this.pending + String(chunk);
    this.pending = '';
    const keys = [];
    let i = 0;
    const plainRun = () => {
      let text = '';
      while (i < data.length) {
        const ch = data[i];
        if (ch === '\x1b' || CONTROL_KEYS[ch] || ch < ' ') break;
        text += ch;
        i += 1;
      }
      return text;
    };
    while (i < data.length) {
      if (this.pasting !== null) {
        const end = data.indexOf('\x1b[201~', i);
        if (end === -1) {
          // Keep a possible partial terminator for the next chunk.
          const tail = data.slice(i);
          const keep = Math.min(tail.length, 5);
          this.pasting += tail.slice(0, tail.length - keep);
          this.pending = tail.slice(tail.length - keep);
          return keys;
        }
        this.pasting += data.slice(i, end);
        keys.push({ name: 'paste', text: this.pasting.replace(/\r\n?/g, '\n') });
        this.pasting = null;
        i = end + 6;
        continue;
      }
      const ch = data[i];
      if (ch === '\x1b') {
        const next = data[i + 1];
        if (next === undefined) { keys.push({ name: 'escape', stroke: 'escape' }); i += 1; continue; }
        if (next === '[' || next === 'O') {
          let j = i + 2;
          while (j < data.length && !/[@-~]/.test(data[j])) j += 1;
          if (j >= data.length) { this.pending = data.slice(i); return keys; }
          const params = data.slice(i + 2, j);
          const final = data[j];
          i = j + 1;
          if (final === '~' && params === '200') { this.pasting = ''; continue; }
          if (final === '~' && params === '201') continue;
          const parts = params.split(';');
          const modifier = Number(parts[1] || 1);
          if (final === 'u' || (final === '~' && parts[0] === '27')) {
            // Kitty / modifyOtherKeys: ESC[13;2u or ESC[27;2;13~ for Shift+Enter.
            const code = final === 'u' ? Number(parts[0]) : Number(parts[2]);
            const mod = final === 'u' ? modifier : Number(parts[1] || 1);
            const prefix = modifierPrefix(mod);
            if (code === 13 && mod > 1) keys.push({ name: 'newline', stroke: prefix + 'enter' });
            else if (code === 13) keys.push({ name: 'enter', stroke: 'enter' });
            else if (code === 9 && mod === 2) keys.push({ name: 'shiftTab', stroke: 'shift+tab' });
            else if (code === 27) keys.push({ name: 'escape', stroke: prefix + 'escape' });
            else if (code >= 32) {
              const text = String.fromCodePoint(code);
              const ctrlLetter = mod > 1 && (Math.max(0, mod - 1) & 4) && /[a-z]/i.test(text);
              keys.push(ctrlLetter ? { name: CONTROL_KEYS[String.fromCharCode(text.toLowerCase().charCodeAt(0) - 96)] || 'ctrlKey', stroke: prefix + text.toLowerCase() } : { name: 'char', text, stroke: prefix + charStroke(text) });
            }
            continue;
          }
          if (final === '~') { const name = TILDE_KEYS[parts[0]]; if (name) keys.push({ name, stroke: modifierPrefix(modifier) + (SPECIAL_STROKES[name] || name) }); continue; }
          const name = CSI_FINAL[final];
          if (!name) continue;
          const stroke = name === 'shiftTab' ? 'shift+tab' : modifierPrefix(modifier) + (SPECIAL_STROKES[name] || name);
          if ((name === 'left' || name === 'right') && (modifier === 3 || modifier === 5 || modifier === 9)) keys.push({ name: name === 'left' ? 'wordLeft' : 'wordRight', stroke });
          else keys.push({ name, stroke });
          continue;
        }
        // Alt/Meta + key.
        i += 2;
        if (next === '\r' || next === '\n') keys.push({ name: 'newline', stroke: 'meta+enter' });
        else if (next === 'b' || next === 'B') keys.push({ name: 'wordLeft', stroke: 'meta+' + charStroke(next) });
        else if (next === 'f' || next === 'F') keys.push({ name: 'wordRight', stroke: 'meta+' + charStroke(next) });
        else if (next === 'd') keys.push({ name: 'deleteWord', stroke: 'meta+d' });
        else if (next === '\x7f' || next === '\b') keys.push({ name: 'killWord', stroke: 'meta+backspace' });
        else if (next === '\x1b') { keys.push({ name: 'escape', stroke: 'escape' }); i -= 1; }
        else keys.push({ name: 'meta', text: next, stroke: 'meta+' + (controlStroke(next) || charStroke(next)) });
        continue;
      }
      const control = CONTROL_KEYS[ch];
      if (control) {
        // Unbracketed multi-line paste: Enter followed by more text in the same chunk.
        if (control === 'enter' && i + 1 < data.length && data[i + 1] !== '\x1b' && data.length - i > 2 && !CONTROL_KEYS[data[i + 1]] ) {
          let text = '';
          while (i < data.length && data[i] !== '\x1b') { text += data[i]; i += 1; }
          keys.push({ name: 'paste', text: text.replace(/\r\n?/g, '\n') });
          continue;
        }
        keys.push({ name: control, stroke: controlStroke(ch) });
        i += 1;
        continue;
      }
      if (ch < ' ') { const stroke = controlStroke(ch); if (stroke) keys.push({ name: 'ctrlKey', stroke }); i += 1; continue; }
      const text = plainRun();
      if (text) keys.push({ name: 'char', text, ...([...text].length === 1 ? { stroke: charStroke(text) } : {}) });
    }
    return keys;
  }
}

// ---------------------------------------------------------------------------
// Pure editing state

export function createEditorState({ history = [], text = '' } = {}) {
  return { text, cursor: text.length, history: history.slice(), historyIndex: history.length, draft: '', search: null, killRing: '', undo: [] };
}

function prevBoundary(text, index) {
  if (index <= 0) return 0;
  const code = text.charCodeAt(index - 1);
  return code >= 0xdc00 && code <= 0xdfff && index >= 2 ? index - 2 : index - 1;
}
function nextBoundary(text, index) {
  if (index >= text.length) return text.length;
  const code = text.charCodeAt(index);
  return code >= 0xd800 && code <= 0xdbff ? index + 2 : index + 1;
}
function wordLeft(text, index) {
  let i = index;
  while (i > 0 && /\s/.test(text[i - 1])) i -= 1;
  while (i > 0 && !/\s/.test(text[i - 1])) i -= 1;
  return i;
}
function wordRight(text, index) {
  let i = index;
  while (i < text.length && /\s/.test(text[i])) i += 1;
  while (i < text.length && !/\s/.test(text[i])) i += 1;
  return i;
}
function lineInfo(text, cursor) {
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
  let lineEnd = text.indexOf('\n', cursor);
  if (lineEnd === -1) lineEnd = text.length;
  return { lineStart, lineEnd, column: cursor - lineStart };
}

function withText(state, text, cursor) {
  if (text !== state.text) state.undo = [...state.undo.slice(-49), { text: state.text, cursor: state.cursor }];
  return { ...state, text, cursor: Math.max(0, Math.min(cursor, text.length)) };
}

export function insertText(state, value) {
  const text = state.text.slice(0, state.cursor) + value + state.text.slice(state.cursor);
  return withText(state, text, state.cursor + value.length);
}

function searchHistory(history, query, before) {
  if (!query) return -1;
  const needle = query.toLowerCase();
  for (let i = Math.min(before, history.length) - 1; i >= 0; i -= 1) {
    if (history[i].toLowerCase().includes(needle)) return i;
  }
  return -1;
}

// Applies one key to the state. Returns { state, action } where action is
// null (keep editing) or one of: submit, eof, interrupt, complete, shiftTab,
// clearScreen, escape, pasteImage, bell.
export function applyKey(state, key) {
  if (state.search) return applySearchKey(state, key);
  const { text, cursor } = state;
  switch (key.name) {
    case 'char': return { state: insertText(state, key.text), action: null };
    case 'paste': return { state: insertText(state, key.text.replace(/\t/g, '    ')), action: null };
    case 'newline': return { state: insertText(state, '\n'), action: null };
    case 'enter': {
      // A trailing backslash continues onto a new line, like a shell.
      if (cursor === text.length && text.endsWith('\\') && !text.endsWith('\\\\')) {
        return { state: withText(state, text.slice(0, -1) + '\n', text.length), action: null };
      }
      return { state, action: 'submit' };
    }
    case 'backspace': {
      if (!cursor) return { state, action: 'bell' };
      const start = prevBoundary(text, cursor);
      return { state: withText(state, text.slice(0, start) + text.slice(cursor), start), action: null };
    }
    case 'delete': {
      if (cursor >= text.length) return { state, action: null };
      return { state: withText(state, text.slice(0, cursor) + text.slice(nextBoundary(text, cursor)), cursor), action: null };
    }
    case 'ctrlD': {
      if (!text) return { state, action: 'eof' };
      if (cursor >= text.length) return { state, action: null };
      return { state: withText(state, text.slice(0, cursor) + text.slice(nextBoundary(text, cursor)), cursor), action: null };
    }
    case 'left': return { state: { ...state, cursor: prevBoundary(text, cursor) }, action: null };
    case 'right': return { state: { ...state, cursor: nextBoundary(text, cursor) }, action: null };
    case 'wordLeft': return { state: { ...state, cursor: wordLeft(text, cursor) }, action: null };
    case 'wordRight': return { state: { ...state, cursor: wordRight(text, cursor) }, action: null };
    case 'home': { const { lineStart } = lineInfo(text, cursor); return { state: { ...state, cursor: lineStart }, action: null }; }
    case 'end': { const { lineEnd } = lineInfo(text, cursor); return { state: { ...state, cursor: lineEnd }, action: null }; }
    case 'killEnd': {
      const { lineEnd } = lineInfo(text, cursor);
      const end = lineEnd === cursor && cursor < text.length ? cursor + 1 : lineEnd;
      return { state: { ...withText(state, text.slice(0, cursor) + text.slice(end), cursor), killRing: text.slice(cursor, end) }, action: null };
    }
    case 'killStart': {
      const { lineStart } = lineInfo(text, cursor);
      return { state: { ...withText(state, text.slice(0, lineStart) + text.slice(cursor), lineStart), killRing: text.slice(lineStart, cursor) }, action: null };
    }
    case 'killWord': {
      const start = wordLeft(text, cursor);
      return { state: { ...withText(state, text.slice(0, start) + text.slice(cursor), start), killRing: text.slice(start, cursor) }, action: null };
    }
    case 'deleteWord': {
      const end = wordRight(text, cursor);
      return { state: { ...withText(state, text.slice(0, cursor) + text.slice(end), cursor), killRing: text.slice(cursor, end) }, action: null };
    }
    case 'yank': return state.killRing ? { state: insertText(state, state.killRing), action: null } : { state, action: 'bell' };
    case 'undo': {
      const last = state.undo[state.undo.length - 1];
      if (!last) return { state, action: 'bell' };
      return { state: { ...state, text: last.text, cursor: last.cursor, undo: state.undo.slice(0, -1) }, action: null };
    }
    case 'up': {
      const { lineStart, column } = lineInfo(text, cursor);
      if (lineStart > 0) {
        const prev = lineInfo(text, lineStart - 1);
        return { state: { ...state, cursor: prev.lineStart + Math.min(column, prev.lineEnd - prev.lineStart) }, action: null };
      }
      if (state.historyIndex <= 0) return { state, action: 'bell' };
      const draft = state.historyIndex === state.history.length ? text : state.draft;
      const index = state.historyIndex - 1;
      const value = state.history[index];
      return { state: { ...state, historyIndex: index, draft, text: value, cursor: value.length }, action: null };
    }
    case 'down': {
      const { lineEnd, column } = lineInfo(text, cursor);
      if (lineEnd < text.length) {
        const next = lineInfo(text, lineEnd + 1);
        return { state: { ...state, cursor: next.lineStart + Math.min(column, next.lineEnd - next.lineStart) }, action: null };
      }
      if (state.historyIndex >= state.history.length) return { state, action: 'bell' };
      const index = state.historyIndex + 1;
      const value = index === state.history.length ? state.draft : state.history[index];
      return { state: { ...state, historyIndex: index, text: value, cursor: value.length }, action: null };
    }
    case 'search': return { state: { ...state, search: { query: '', match: -1, original: { text, cursor } } }, action: null };
    case 'tab': return { state, action: 'complete' };
    case 'shiftTab': return { state, action: 'shiftTab' };
    case 'clearScreen': return { state, action: 'clearScreen' };
    case 'ctrlC': return { state, action: 'interrupt' };
    case 'escape': return { state, action: 'escape' };
    case 'ctrlV': return { state, action: 'pasteImage' };
    case 'ctrlO': return { state, action: 'transcript' };
    case 'ctrlT': return { state, action: 'todos' };
    default: return { state, action: null };
  }
}

function applySearchKey(state, key) {
  const search = state.search;
  const finish = (accept) => {
    const value = accept && search.match >= 0 ? state.history[search.match] : search.original.text;
    const cursor = accept && search.match >= 0 ? value.length : search.original.cursor;
    return { ...state, search: null, text: value, cursor };
  };
  switch (key.name) {
    case 'char':
    case 'paste': {
      const query = search.query + key.text;
      const match = searchHistory(state.history, query, state.history.length);
      return { state: { ...state, search: { ...search, query, match } }, action: match < 0 ? 'bell' : null };
    }
    case 'backspace': {
      const query = search.query.slice(0, -1);
      const match = searchHistory(state.history, query, state.history.length);
      return { state: { ...state, search: { ...search, query, match } }, action: null };
    }
    case 'search': {
      const match = searchHistory(state.history, search.query, search.match >= 0 ? search.match : state.history.length);
      if (match < 0) return { state, action: 'bell' };
      return { state: { ...state, search: { ...search, match } }, action: null };
    }
    case 'escape':
    case 'ctrlG':
    case 'ctrlC': return { state: finish(false), action: null };
    case 'enter':
    case 'searchAccept': return { state: finish(true), action: null };
    case 'searchExecute': return { state: finish(true), action: 'submit' };
    default: {
      const accepted = finish(true);
      return applyKey(accepted, key);
    }
  }
}

// Replaces text[start, end) with value and moves the cursor after it.
export function applyCompletion(state, { start, end }, value) {
  const text = state.text.slice(0, start) + value + state.text.slice(end);
  return withText(state, text, start + value.length);
}

export function commonPrefix(values) {
  if (!values.length) return '';
  let prefix = values[0];
  for (const value of values.slice(1)) {
    let i = 0;
    while (i < prefix.length && i < value.length && prefix[i].toLowerCase() === value[i].toLowerCase()) i += 1;
    prefix = prefix.slice(0, i);
  }
  return prefix;
}

// ---------------------------------------------------------------------------
// Layout: computes the frame to draw and where the cursor sits, accounting for
// wrapping at the terminal width.

export function layoutFrame({ prompt, continuation, text, cursor, hints = [], columns = 80 }) {
  const cols = Math.max(10, columns || 80);
  const lines = text.split('\n');
  const before = text.slice(0, cursor).split('\n');
  const cursorLine = before.length - 1;
  const cursorText = before[cursorLine];
  const segments = [
    ...lines.map((body, index) => ({ prefix: index ? continuation : prompt, body })),
    ...hints.map((hint) => ({ prefix: '', body: truncateToWidth(hint, cols - 1) }))
  ];
  let out = '';
  let row = 0;
  let cursorRow = 0;
  let cursorCol = 0;
  let endRow = 0;
  segments.forEach((segment, index) => {
    const width = stringWidth(segment.prefix) + stringWidth(segment.body);
    if (index === cursorLine) {
      const cw = stringWidth(segment.prefix) + stringWidth(cursorText);
      cursorRow = row + Math.floor(cw / cols);
      cursorCol = cw % cols;
    }
    out += segment.prefix + segment.body;
    if (index < segments.length - 1) {
      out += '\r\n';
      row += Math.max(1, Math.ceil(width / cols));
    } else {
      if (width > 0 && width % cols === 0) out += '\r\n';
      endRow = row + Math.floor(width / cols);
    }
  });
  return { out, cursorRow, cursorCol, endRow };
}

// ---------------------------------------------------------------------------
// TTY wiring

const DIM = (text, color) => (color ? '\x1b[2m' + text + '\x1b[22m' : text);

// Prompt stash shared across readInput calls (Ctrl+S, chat:stash).
export const stash = { text: '', pendingRestore: false };

export const SHORTCUTS_HELP = [
  '  Enter send · Shift+Enter, Alt+Enter, Ctrl+J or a trailing \\ add a line · Tab complete /commands and @files',
  '  ↑/↓ history · Ctrl+R search history · Shift+Tab cycle permission mode · Esc Esc clear input (empty: rewind)',
  '  ! run a shell command · # save a memory note · Ctrl+V paste an image · Ctrl+L clear screen · Ctrl+D exit',
  '  Ctrl+G or Ctrl+X Ctrl+E edit the prompt in $EDITOR · Ctrl+S stash the prompt · /vim toggles vim editing',
  '  Rebind keys in ~/.claude/keybindings.json or ~/.oasis/keybindings.json (/keybindings)'
];

// Reads one message from a TTY. Resolves to { type: 'submit', text } or
// { type: 'eof' }. Falls back to the caller when stdin is not a TTY.
export function readInput(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const color = options.color !== false && !process.env.NO_COLOR && process.env.OASIS_AX_SCREEN_READER !== '1' && process.env.CLAUDE_AX_SCREEN_READER !== '1';
  const history = options.history || [];
  const columns = () => output.columns || 80;
  return new Promise((resolve) => {
    // A stashed prompt (Ctrl+S) comes back at the next prompt after a message is sent.
    const restored = !options.initialText && stash.text && stash.pendingRestore ? stash.text : '';
    if (restored) { stash.text = ''; stash.pendingRestore = false; }
    let state = createEditorState({ history, text: options.initialText || restored });
    if (options.vim) state.vim = createVimState(options.vim === 'normal' ? 'normal' : 'insert');
    let hints = [];
    let previousCursorRow = 0;
    let lastCtrlC = 0;
    let lastEscape = 0;
    let completion = null; // { range, candidates, index }
    let palette = null;
    let paletteScreen = false;
    let busy = Promise.resolve();
    let done = false;
    const decoder = new KeyDecoder();
    const wasRaw = Boolean(input.isRaw);

    const promptText = () => (typeof options.prompt === 'function' ? options.prompt(state) : options.prompt || '> ');
    const continuation = () => ' '.repeat(Math.max(0, stringWidth(promptText()) - 2)) + DIM('… ', color);
    const footer = () => {
      const line = typeof options.footer === 'function' ? options.footer(state) : '';
      return line ? [line] : [];
    };

    const draw = (final = false) => {
      let rows = [];
      if (!final) {
        if (state.search) rows = [DIM('(reverse-i-search) ', color) + state.search.query + (state.search.match < 0 && state.search.query ? DIM('  (no match)', color) : '')];
        else rows = [...hints, ...(state.vim ? [DIM(vimModeLabel(state), color)] : []), ...footer()];
      }
      const frame = layoutFrame({ prompt: promptText(), continuation: continuation(), text: state.text, cursor: final ? state.text.length : state.cursor, hints: rows, columns: columns() });
      let s = '';
      if (previousCursorRow > 0) s += '\x1b[' + previousCursorRow + 'A';
      s += '\r\x1b[J' + frame.out;
      const up = frame.endRow - frame.cursorRow;
      if (up > 0) s += '\x1b[' + up + 'A';
      s += '\r';
      if (frame.cursorCol > 0) s += '\x1b[' + frame.cursorCol + 'C';
      output.write(s);
      previousCursorRow = frame.cursorRow;
    };

    const paletteMatches = () => {
      if (!palette) return [];
      const query = String(palette.query || '').trim().toLowerCase();
      if (!query) return palette.items.map((item, index) => ({ item, index, score: index }));
      const words = query.split(/\s+/).filter(Boolean);
      const matched = [];
      for (const [index, item] of palette.items.entries()) {
        const haystack = [item.label, item.description, item.category, item.value].join(' ').toLowerCase();
        let score = 0;
        let ok = true;
        for (const word of words) {
          const at = haystack.indexOf(word);
          if (at >= 0) score += at === 0 ? 0 : at + 1;
          else {
            let pos = 0;
            let gaps = 0;
            for (const ch of word) {
              const found = haystack.indexOf(ch, pos);
              if (found < 0) { ok = false; break; }
              gaps += found - pos;
              pos = found + 1;
            }
            if (!ok) break;
            score += 30 + gaps;
          }
        }
        if (ok) matched.push({ item, index, score });
      }
      return matched.sort((a, b) => a.score - b.score || a.index - b.index);
    };
    const drawPalette = () => {
      if (!palette) return;
      const width = Math.max(32, output.columns || 80);
      const height = Math.max(10, output.rows || 24);
      const rows = Math.max(3, Math.min(12, height - 7));
      const matches = paletteMatches();
      palette.selected = Math.max(0, Math.min(palette.selected, Math.max(0, matches.length - 1)));
      const top = Math.max(0, Math.min(palette.selected - Math.floor(rows / 2), Math.max(0, matches.length - rows)));
      const lines = [
        truncateToWidth(' OASIS COMMAND PALETTE', width),
        truncateToWidth(' Search: ' + (palette.query || '') + '▏', width),
        truncateToWidth('─'.repeat(width), width)
      ];
      if (!matches.length) lines.push('  No matches. Try another word.');
      else {
        for (let offset = 0; offset < rows; offset += 1) {
          const entry = matches[top + offset];
          if (!entry) { lines.push(''); continue; }
          const item = entry.item;
          const prefix = entry.index === matches[palette.selected].index ? ' › ' : '   ';
          const category = item.category ? '[' + item.category + '] ' : '';
          const detail = item.description ? ' — ' + item.description : '';
          const line = truncateToWidth(prefix + category + item.label + detail, width);
          lines.push(entry.index === matches[palette.selected].index && color ? '\x1b[7m' + line + '\x1b[27m' : line);
        }
      }
      lines.push(truncateToWidth(' Enter select · ↑↓ move · type to search · Ctrl+U clear · Esc close', width));
      while (lines.length < height) lines.push('');
      output.write('\x1b[H\x1b[2J' + lines.slice(0, height).join('\r\n'));
    };
    const closePalette = (chosen = null) => {
      palette = null;
      if (paletteScreen) { output.write('\x1b[?1049l'); paletteScreen = false; }
      previousCursorRow = 0;
      if (chosen && chosen.value) {
        state = insertText(state, chosen.value);
        hints = [DIM('Added ' + chosen.value + ' to the prompt. Press Enter to run it, or edit it first.', color)];
      }
      draw();
    };
    const openCommandPalette = async () => {
      if (typeof options.onCommandPalette !== 'function') {
        hints = [DIM('The command palette is not available in this context.', color)];
        return;
      }
      try {
        const supplied = await options.onCommandPalette();
        const source = Array.isArray(supplied) ? supplied : (supplied && Array.isArray(supplied.items) ? supplied.items : []);
        const items = source.slice(0, 500).filter((item) =>
          item && typeof item.label === 'string' && typeof item.value === 'string' && item.value.length <= 1000
        ).map((item) => ({
          label: item.label.replace(/[\r\n\0]/g, ' ').slice(0, 160),
          value: item.value.replace(/[\r\n\0]/g, ' ').slice(0, 1000),
          description: String(item.description || '').replace(/[\r\n\0]/g, ' ').slice(0, 220),
          category: String(item.category || 'Commands').replace(/[\r\n\0]/g, ' ').slice(0, 40)
        }));
        palette = { items, query: '', selected: 0 };
        paletteScreen = true;
        output.write('\x1b[?1049h');
        drawPalette();
      } catch (error) {
        palette = null;
        hints = [DIM('Could not open the command palette: ' + String(error && error.message || 'try again').slice(0, 160), color)];
      }
    };
    const paletteKey = (key) => {
      if (!palette) return;
      if (key.name === 'escape' || key.name === 'ctrlC' || key.stroke === 'ctrl+k') { closePalette(); return; }
      if (key.name === 'enter') {
        const matches = paletteMatches();
        closePalette(matches.length ? matches[palette.selected]?.item : null);
        return;
      }
      if (key.name === 'up' || key.name === 'ctrlP') palette.selected -= 1;
      else if (key.name === 'down' || key.name === 'ctrlN') palette.selected += 1;
      else if (key.name === 'pageUp') palette.selected -= Math.max(1, Math.min(12, (output.rows || 24) - 7));
      else if (key.name === 'pageDown') palette.selected += Math.max(1, Math.min(12, (output.rows || 24) - 7));
      else if (key.name === 'backspace' || key.name === 'killWord') palette.query = Array.from(palette.query).slice(0, -1).join('');
      else if (key.name === 'killStart' || key.stroke === 'ctrl+u') palette.query = '';
      else if (key.name === 'char' && key.text && !/[\r\n\0]/.test(key.text)) {
        if (palette.query.length < 160) palette.query += key.text;
        palette.selected = 0;
      }
      const count = paletteMatches().length;
      palette.selected = Math.max(0, Math.min(palette.selected, Math.max(0, count - 1)));
      drawPalette();
    };

    const finish = (result) => {
      if (done) return;
      done = true;
      hints = [];
      if (paletteScreen) { output.write('\x1b[?1049l'); paletteScreen = false; palette = null; }
      if (result.type === 'submit') draw(true);
      else { state = { ...state, text: '' }; draw(true); }
      output.write('\r\n\x1b[?2004l');
      input.off('data', onData);
      output.off && output.off('resize', onResize);
      try { input.setRawMode(wasRaw); } catch {}
      input.pause();
      resolve(result);
    };

    const runCompletion = async () => {
      if (!options.complete) return;
      if (completion && completion.candidates.length > 1) {
        completion.index = (completion.index + 1) % completion.candidates.length;
        const candidate = completion.candidates[completion.index];
        const range = { start: completion.range.start, end: completion.range.start + completion.applied.length };
        state = applyCompletion(state, range, candidate.value);
        completion.applied = candidate.value;
        hints = renderCandidates(completion.candidates, completion.index, color);
        return;
      }
      let result = null;
      try { result = await options.complete(state.text, state.cursor); } catch { result = null; }
      if (!result || !result.candidates || !result.candidates.length) { output.write('\x07'); return; }
      const { candidates } = result;
      const range = { start: result.start, end: result.end };
      if (candidates.length === 1) {
        const value = candidates[0].value + (candidates[0].value.endsWith('/') || candidates[0].noSpace ? '' : ' ');
        state = applyCompletion(state, range, value);
        hints = [];
        completion = null;
        return;
      }
      const current = state.text.slice(range.start, range.end);
      const prefix = commonPrefix(candidates.map((c) => c.value));
      if (prefix.length > current.length) {
        state = applyCompletion(state, range, prefix);
        completion = { range, candidates, index: -1, applied: prefix };
      } else {
        completion = { range, candidates, index: -1, applied: current };
      }
      hints = renderCandidates(candidates, -1, color);
    };

    const bindings = options.keybindings === false ? null : (() => { try { return loadKeybindings(options.env || process.env); } catch { return null; } })();
    let chord = null; // { sequence, at }

    const openExternalEditor = () => {
      const editor = (options.env || process.env).VISUAL || (options.env || process.env).EDITOR || (process.platform === 'win32' ? 'notepad' : 'vi');
      const dir = mkdtempSync(joinPath(tmpdir(), 'oasis-prompt-'));
      const file = joinPath(dir, 'prompt.md');
      try {
        writeFileSync(file, state.text, 'utf8');
        input.off('data', onData);
        try { input.setRawMode(false); } catch {}
        output.write('\r\n\x1b[?2004l');
        const run = spawnSync(editor + ' ' + JSON.stringify(file), { stdio: 'inherit', shell: true });
        try { input.setRawMode(true); } catch {}
        output.write('\x1b[?2004h');
        input.on('data', onData);
        previousCursorRow = 0;
        if (run.status !== 0 && run.status !== null) { hints = [DIM('Editor exited with status ' + run.status + '; draft unchanged.', color)]; return; }
        const text = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
        state = { ...state, text, cursor: text.length, undo: [...state.undo.slice(-49), { text: state.text, cursor: state.cursor }] };
        hints = [];
      } catch (error) {
        hints = [DIM('Could not open ' + editor + ': ' + error.message, color)];
      } finally { rmSync(dir, { recursive: true, force: true }); }
    };

    // Maps a key through keybindings.json. Returns the key to apply, or null when consumed.
    const bindKey = async (key) => {
      if (!bindings || !key.stroke) { chord = null; return key; }
      if (state.vim && state.vim.mode === 'normal' && (key.name === 'char' || key.name === 'escape') && !chord) return key;
      const now = Date.now();
      const sequence = chord && now - chord.at <= CHORD_TIMEOUT_MS ? chord.sequence + ' ' + key.stroke : key.stroke;
      const inChord = Boolean(chord && now - chord.at <= CHORD_TIMEOUT_MS);
      chord = null;
      const context = state.search ? 'HistorySearch' : completion && hints.length ? 'Autocomplete' : 'Chat';
      const hit = resolveBinding(bindings, context, sequence);
      if (hit && hit.prefix) { chord = { sequence, at: now }; hints = [DIM(sequence + ' …', color)]; return null; }
      if (inChord && (!hit || hit.unbound)) { hints = []; output.write('\x07'); return null; }
      if (inChord) hints = [];
      if (!hit) return key;
      if (hit.unbound) return null;
      const effect = actionEffect(hit.action);
      if (!effect) return null;
      if (effect.key) {
        // Default bindings keep the editor's own handling of the key (e.g. Esc in vim, Ctrl+R in search).
        if (!inChord && [context, 'Chat', 'Global'].some((name) => DEFAULT_BINDINGS[name] && DEFAULT_BINDINGS[name][sequence] === hit.action)) return key;
        return { name: effect.key, stroke: key.stroke, text: key.text };
      }
      if (effect.command) { finish({ type: 'submit', text: '/' + effect.command }); return null; }
      if (effect.action === 'commandPalette') { await openCommandPalette(); return null; }
      if (effect.action === 'externalEditor') { openExternalEditor(); return null; }
      if (effect.action === 'stash') {
        if (state.text.trim()) { stash.text = state.text; state = { ...state, text: '', cursor: 0, undo: [...state.undo, { text: state.text, cursor: state.cursor }] }; hints = [DIM('Prompt stashed; it comes back after your next message (Ctrl+S on an empty prompt restores it now).', color)]; }
        else if (stash.text) { state = { ...state, text: stash.text, cursor: stash.text.length }; stash.text = ''; hints = []; }
        else output.write('\x07');
        return null;
      }
      if (effect.action === 'redraw') { output.write('\x1b[2J\x1b[H'); previousCursorRow = 0; return null; }
      return null;
    };

    // Full-screen pager for Ctrl+O: the transcript handler may return { pager: lines }.
    let pager = null;
    const pageRows = () => Math.max(3, (output.rows || 24) - 1);
    const drawPager = () => {
      const rows = pageRows();
      const maxTop = Math.max(0, pager.lines.length - rows);
      pager.top = Math.min(Math.max(0, pager.top), maxTop);
      const shown = pager.lines.slice(pager.top, pager.top + rows);
      const end = Math.min(pager.lines.length, pager.top + rows);
      const status = DIM(' transcript ' + (pager.lines.length ? pager.top + 1 : 0) + '-' + end + ' of ' + pager.lines.length + ' · ↑↓/j k scroll · space/b page · g/G top/bottom · q, Esc or Ctrl+O to return', color);
      output.write('\x1b[H\x1b[2J' + shown.join('\r\n') + '\r\n'.repeat(Math.max(1, rows - shown.length + 1)) + status);
    };
    const pagerKey = (key) => {
      const rows = pageRows();
      const ch = key.name === 'char' ? key.text : '';
      if (key.name === 'escape' || key.name === 'ctrlO' || key.name === 'ctrlC' || ch === 'q') {
        pager = null;
        output.write('\x1b[?1049l');
        draw();
        return;
      }
      if (key.name === 'down' || ch === 'j' || key.name === 'enter') pager.top += 1;
      else if (key.name === 'up' || ch === 'k') pager.top -= 1;
      else if (ch === ' ' || key.name === 'pageDown' || key.name === 'ctrlF') pager.top += rows - 1;
      else if (ch === 'b' || key.name === 'pageUp' || key.name === 'ctrlB') pager.top -= rows - 1;
      else if (ch === 'g' || key.name === 'home') pager.top = 0;
      else if (ch === 'G' || key.name === 'end') pager.top = pager.lines.length;
      drawPager();
    };
    const handle = async (rawKey) => {
      if (pager) { pagerKey(rawKey); return; }
      if (palette) { paletteKey(rawKey); return; }
      const key = await bindKey(rawKey);
      if (done) return;
      if (!key) { if (palette) drawPalette(); else draw(); return; }
      if (key.name !== 'tab') completion = null;
      if (key.name !== 'ctrlC') lastCtrlC = 0;
      const wasHinting = hints.length > 0;
      let outcome = state.vim && !state.search ? applyVimKey(state, key) : null;
      if (!outcome) {
        outcome = applyKey(state, key);
        if (state.vim) outcome = { ...outcome, state: trackInsert(state, outcome.state) };
      }
      const { state: next, action } = outcome;
      state = next;
      if (action !== 'complete' && wasHinting && action !== 'escape') hints = [];
      switch (action) {
        case 'submit': {
          if (state.text.trim() === '?' && !options.allowQuestionMark) { state = { ...state, text: '', cursor: 0 }; hints = SHORTCUTS_HELP.map((line) => DIM(line, color)); break; }
          if (stash.text) stash.pendingRestore = true;
          finish({ type: 'submit', text: state.text });
          return;
        }
        case 'eof': finish({ type: 'eof' }); return;
        case 'interrupt': {
          if (state.text) { state = { ...state, text: '', cursor: 0 }; hints = []; break; }
          const now = Date.now();
          if (lastCtrlC && now - lastCtrlC < 2000) { finish({ type: 'eof' }); return; }
          lastCtrlC = now;
          hints = [DIM('Press Ctrl+C again to exit', color)];
          break;
        }
        case 'escape': {
          if (wasHinting) { hints = []; break; }
          const now = Date.now();
          if (lastEscape && now - lastEscape < 800) {
            lastEscape = 0;
            if (state.text) { state = { ...state, text: '', cursor: 0, undo: [...state.undo, { text: state.text, cursor: state.cursor }] }; break; }
            if (options.onDoubleEscape) { finish({ type: 'submit', text: options.onDoubleEscape() }); return; }
            break;
          }
          lastEscape = now;
          break;
        }
        case 'complete': await runCompletion(); break;
        case 'shiftTab': if (options.onShiftTab) { try { await options.onShiftTab(); } catch {} } break;
        case 'clearScreen': output.write('\x1b[2J\x1b[H'); previousCursorRow = 0; break;
        case 'pasteImage': {
          if (!options.onPasteImage) { output.write('\x07'); break; }
          try {
            const token = await options.onPasteImage();
            if (token) state = insertText(state, (state.text && !/\s$/.test(state.text.slice(0, state.cursor)) ? ' ' : '') + token + ' ');
            else hints = [DIM('No image found on the clipboard.', color)];
          } catch (error) { hints = [DIM('Image paste failed: ' + error.message, color)]; }
          break;
        }
        case 'transcript':
        case 'todos': {
          const handler = action === 'transcript' ? options.onTranscript : options.onTodos;
          if (handler) {
            try {
              const lines = await handler();
              if (lines && Array.isArray(lines.pager)) {
                pager = { lines: lines.pager, top: Math.max(0, lines.pager.length - pageRows()) };
                output.write('\x1b[?1049h');
                drawPager();
                return;
              }
              hints = (lines || []).map((line) => DIM(line, color));
            } catch {}
          }
          break;
        }
        case 'bell': output.write('\x07'); break;
        default: break;
      }
      if (!done) draw();
    };

    const onData = (chunk) => {
      const keys = decoder.feed(chunk.toString('utf8'));
      for (const key of keys) busy = busy.then(() => (done ? null : handle(key)));
    };
    const onResize = () => { if (!done) { if (pager) drawPager(); else draw(); } };

    try { input.setRawMode(true); } catch {}
    input.setEncoding && input.setEncoding('utf8');
    input.resume();
    input.on('data', onData);
    output.on && output.on('resize', onResize);
    output.write('\x1b[?2004h');
    draw();
    // Lets a scheduler submit a prompt while the editor is idle and empty.
    if (options.onReady) options.onReady((text) => { if (done || state.text.trim()) return false; state = { ...state, text: String(text), cursor: String(text).length }; finish({ type: 'submit', text: String(text), external: true }); return true; });
  });
}

function renderCandidates(candidates, selected, color) {
  const shown = candidates.slice(0, 8);
  const width = Math.min(40, Math.max(...shown.map((c) => stringWidth(c.display || c.value))) + 2);
  const lines = shown.map((candidate, index) => {
    const label = (candidate.display || candidate.value).padEnd(width);
    const description = candidate.description ? DIM(candidate.description, color) : '';
    const line = '  ' + label + description;
    return index === selected && color ? '\x1b[7m' + stripAnsi('  ' + label) + '\x1b[27m' + description : line;
  });
  if (candidates.length > shown.length) lines.push(DIM('  … ' + (candidates.length - shown.length) + ' more (keep typing to narrow)', color));
  return lines;
}
