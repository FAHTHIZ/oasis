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
import stringWidthText from 'string-width';
import stripAnsiText from 'strip-ansi';
import { StdinBuffer } from '@earendil-works/pi-tui/dist/stdin-buffer.js';
import { parseKey, decodeKittyPrintable, isKeyRelease, setKittyProtocolActive } from '@earendil-works/pi-tui/dist/keys.js';
import { prevGrapheme, nextGrapheme, wordBackward, wordForward, columnOf, indexAtColumn } from './text-cursor.mjs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';

// Synchronized output (DEC private mode 2026): supported by kitty, WezTerm,
// iTerm2, Ghostty, Alacritty, foot, Windows Terminal and others; ignored
// elsewhere. OASIS_SYNC_OUTPUT=0 turns it off.
const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
function synchronizedOutputEnabled(env = process.env) {
  if (/^(?:0|false|no|off)$/i.test(String(env.OASIS_SYNC_OUTPUT || ''))) return false;
  return !['dumb', 'linux'].includes(String(env.TERM || ''));
}
const SYNC_OUTPUT = synchronizedOutputEnabled();

// Display width follows string-width (graphemes, East Asian Width, RGI emoji);
// plain printable ASCII, the common case, skips it.
const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function stripAnsi(text) {
  return stripAnsiText(String(text || ''));
}

export function stringWidth(text) {
  const value = String(text || '');
  if (PRINTABLE_ASCII.test(value)) return value.length;
  return stringWidthText(value);
}

export function truncateToWidth(text, max) {
  const plain = stripAnsi(text);
  if (stringWidth(plain) <= max) return text;
  let out = '';
  let width = 0;
  for (const { segment } of graphemes.segment(plain)) {
    const w = stringWidth(segment);
    if (width + w > max - 1) break;
    out += segment;
    width += w;
  }
  return out + '…';
}

// ---------------------------------------------------------------------------
// Key decoding
//
// Raw input is split into complete sequences by pi-tui's StdinBuffer (from
// pi-mono, after OpenTUI): escape sequences split across reads, bracketed
// paste, terminal replies (OSC/DCS/APC) and a short timeout that tells a lone
// Esc from Alt+key. Each sequence is named by pi-tui's parseKey, which knows
// legacy xterm/VT codes, xterm modifyOtherKeys and the kitty keyboard
// protocol (CSI-u, alternate/base-layout keys, keypad, event types). The
// mapping below turns those names into the editor's key events.

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
  if (code === 0) return 'ctrl+space';
  if (code >= 1 && code <= 26) return 'ctrl+' + String.fromCharCode(code + 96);
  if (code === 0x1f) return 'ctrl+_';
  if (code === 0x1c) return 'ctrl+\\';
  if (code === 0x1d) return 'ctrl+]';
  if (code === 0x1e) return 'ctrl+^';
  return null;
}
const MODIFIER_ORDER = ['ctrl', 'meta', 'shift', 'super'];
const SPECIAL_KEYS = { up: 'up', down: 'down', left: 'left', right: 'right', home: 'home', end: 'end', delete: 'delete', pageUp: 'pageUp', pageDown: 'pageDown', insert: 'insert', clear: 'clear' };
for (let n = 1; n <= 12; n += 1) SPECIAL_KEYS['f' + n] = 'f' + n;
function charStroke(ch) {
  if (ch === ' ') return 'space';
  if (/^[A-Z]$/.test(ch)) return 'shift+' + ch.toLowerCase();
  return ch;
}
const isPlain = (seq) => seq.length > 0 && !seq.startsWith('\x1b') && seq.charCodeAt(0) >= 0x20 && seq !== '\x7f';

// Alt/Meta + a key that produced text (legacy ESC-prefix or kitty CSI-u).
function metaKey(ch) {
  if (ch === '\r' || ch === '\n') return { name: 'newline', stroke: 'meta+enter' };
  if (ch === 'b' || ch === 'B') return { name: 'wordLeft', stroke: 'meta+' + charStroke(ch) };
  if (ch === 'f' || ch === 'F') return { name: 'wordRight', stroke: 'meta+' + charStroke(ch) };
  if (ch === 'd') return { name: 'deleteWord', stroke: 'meta+d' };
  if (ch === '\x7f' || ch === '\b') return { name: 'killWord', stroke: 'meta+backspace' };
  return { name: 'meta', text: ch, stroke: 'meta+' + (controlStroke(ch) || charStroke(ch)) };
}

// One complete non-text sequence -> editor key event (or null to drop it).
function sequenceKey(seq) {
  if (seq.length === 1) {
    if (seq === '\x1b') return { name: 'escape', stroke: 'escape' };
    const control = CONTROL_KEYS[seq];
    if (control) return { name: control, stroke: controlStroke(seq) };
    const stroke = controlStroke(seq);
    return stroke ? { name: 'ctrlKey', stroke } : null;
  }
  if (isKeyRelease(seq)) return null;
  // Legacy Alt+key: ESC followed by the key's own byte(s).
  if (seq[0] === '\x1b' && seq[1] !== '[' && seq[1] !== 'O' && [...seq.slice(1)].length === 1) {
    if (seq === '\x1b\x1b') return { name: 'escape', stroke: 'escape' };
    return metaKey(seq.slice(1));
  }
  const id = parseKey(seq);
  if (!id) return null;
  const parts = id.split('+');
  let key = parts.pop();
  if (key === '' && parts.length) { parts.pop(); key = '+'; }
  const mods = new Set(parts.map((mod) => (mod === 'alt' ? 'meta' : mod)));
  const printable = decodeKittyPrintable(seq);
  if (printable !== undefined) return { name: 'char', text: printable, stroke: charStroke(printable) };
  const prefix = MODIFIER_ORDER.filter((mod) => mods.has(mod)).map((mod) => mod + '+').join('');
  const modified = mods.size > 0;
  if (key === 'enter') return modified ? { name: 'newline', stroke: prefix + 'enter' } : { name: 'enter', stroke: 'enter' };
  if (key === 'tab') return mods.has('shift') ? { name: 'shiftTab', stroke: 'shift+tab' } : { name: 'tab', stroke: prefix + 'tab' };
  if (key === 'escape') return { name: 'escape', stroke: prefix + 'escape' };
  if (key === 'backspace') return mods.has('meta') || mods.has('ctrl') ? { name: 'killWord', stroke: prefix + 'backspace' } : { name: 'backspace', stroke: 'backspace' };
  if (key === 'left' || key === 'right') {
    const word = mods.has('meta') || mods.has('ctrl') || mods.has('super');
    return { name: word ? (key === 'left' ? 'wordLeft' : 'wordRight') : key, stroke: prefix + key };
  }
  if (SPECIAL_KEYS[key]) return { name: SPECIAL_KEYS[key], stroke: prefix + key.toLowerCase() };
  const ch = key === 'space' ? ' ' : key;
  if ([...ch].length !== 1) return null;
  if (mods.has('ctrl') && !mods.has('meta') && /^[a-z]$/.test(ch)) {
    const name = CONTROL_KEYS[String.fromCharCode(ch.charCodeAt(0) - 96)] || 'ctrlKey';
    return { name, stroke: prefix + ch };
  }
  if (mods.has('ctrl') && ch === '-') return { name: 'undo', stroke: 'ctrl+_' };
  if (mods.has('meta') && !mods.has('ctrl')) return metaKey(mods.has('shift') && /^[a-z]$/.test(ch) ? ch.toUpperCase() : ch);
  if (!modified) return { name: 'char', text: ch, stroke: charStroke(ch) };
  return { name: mods.has('ctrl') ? 'ctrlKey' : 'char', ...(mods.has('ctrl') ? {} : { text: mods.has('shift') && /^[a-z]$/.test(ch) ? ch.toUpperCase() : ch }), stroke: prefix + (ch === ' ' ? 'space' : ch) };
}

// Stateful decoder: turns raw terminal input into key events. A run of typed
// text becomes one `char` event; bracketed paste becomes one `paste` event
// (CRLF and CR normalised to LF), even across reads. Incomplete sequences
// wait for the next read. A lone Esc is reported at once, or, when `onKeys`
// is given, after a short timeout so a split Alt+key is not read as Esc + key.
export class KeyDecoder {
  constructor({ onKeys = null, onReply = null, escapeTimeout } = {}) {
    this.onKeys = onKeys;
    this.onReply = onReply;
    this.queue = [];
    this.feeding = false;
    this.buffer = new StdinBuffer(escapeTimeout === undefined ? {} : { escapeTimeout });
    this.buffer.on('data', (seq) => this.queue.push({ seq }));
    this.buffer.on('paste', (text) => this.queue.push({ paste: text }));
    // Sequences flushed by StdinBuffer's timer (outside feed) go to onKeys.
    this.buffer.on('data', () => { if (!this.feeding) this.drainLater(); });
  }

  drainLater() {
    if (this.draining) return;
    this.draining = true;
    queueMicrotask(() => {
      this.draining = false;
      const keys = this.take();
      if (keys.length && this.onKeys) this.onKeys(keys);
    });
  }

  feed(chunk) {
    this.feeding = true;
    try { this.buffer.process(String(chunk)); } finally { this.feeding = false; }
    if (!this.onKeys) {
      // Without a callback nothing can be reported later: a lone Esc is a
      // key now, and the timer must not drop a partial sequence.
      if (this.buffer.getBuffer() === '\x1b') for (const seq of this.buffer.flush()) this.queue.push({ seq });
      else if (this.buffer.timeout) { clearTimeout(this.buffer.timeout); this.buffer.timeout = null; }
    }
    return this.take();
  }

  take() {
    const items = this.queue;
    this.queue = [];
    const keys = [];
    for (let i = 0; i < items.length; i += 1) {
      const item = items[i];
      if (item.paste !== undefined) { keys.push({ name: 'paste', text: item.paste.replace(/\r\n?/g, '\n') }); continue; }
      const { seq } = item;
      if (isPlain(seq)) {
        let text = seq;
        while (i + 1 < items.length && items[i + 1].seq !== undefined && isPlain(items[i + 1].seq)) { i += 1; text += items[i].seq; }
        keys.push({ name: 'char', text, ...([...text].length === 1 ? { stroke: charStroke(text) } : {}) });
        continue;
      }
      // Unbracketed multi-line paste: Enter followed by more text in the same read.
      // A pasted CRLF line break counts too, so "a\r\nb" is not sent at "a".
      const after = items[i + 1] && items[i + 1].seq;
      if (seq === '\r' && after !== undefined && (isPlain(after) || after === '\n' || after === '\r') && items.length - i > 2 && !after.startsWith('\x1b')) {
        let text = '';
        while (i < items.length && items[i].seq !== undefined && !items[i].seq.startsWith('\x1b')) { text += items[i].seq; i += 1; }
        i -= 1;
        keys.push({ name: 'paste', text: text.replace(/\r\n?/g, '\n') });
        continue;
      }
      // Answers to the kitty keyboard query (CSI ? flags u) and to DA1.
      if (/^\x1b\[\?[\d;]*[uc]$/.test(seq)) { if (this.onReply) this.onReply(seq); continue; }
      const key = sequenceKey(seq);
      if (key) keys.push(key);
    }
    return keys;
  }

  // Drops any partial input and pending timer.
  destroy() { this.buffer.destroy(); this.queue = []; }
}

// ---------------------------------------------------------------------------
// Pure editing state

export function createEditorState({ history = [], text = '' } = {}) {
  return { text, cursor: text.length, history: history.slice(), historyIndex: history.length, draft: '', search: null, killRing: '', undo: [] };
}

const prevBoundary = prevGrapheme;
const nextBoundary = nextGrapheme;
// Ctrl+W and Alt+Backspace erase back to whitespace (readline's
// unix-word-rubout); Alt+B/F, Ctrl+Left/Right and Alt+D use word boundaries.
function spaceWordLeft(text, index) {
  let i = index;
  while (i > 0 && /\s/.test(text[i - 1])) i -= 1;
  while (i > 0 && !/\s/.test(text[i - 1])) i -= 1;
  return i;
}
function lineInfo(text, cursor) {
  const lineStart = text.lastIndexOf('\n', cursor - 1) + 1;
  let lineEnd = text.indexOf('\n', cursor);
  if (lineEnd === -1) lineEnd = text.length;
  return { lineStart, lineEnd };
}

function withText(state, text, cursor) {
  if (text !== state.text) state.undo = [...state.undo.slice(-49), { text: state.text, cursor: state.cursor }];
  return { ...state, text, cursor: Math.max(0, Math.min(cursor, text.length)) };
}

// Large pastes show as one placeholder token, like Claude Code's
// "[Pasted text #1 +42 lines]"; the full text goes out on submit.
const PASTE_MIN_LINES = 10;
const PASTE_MIN_CHARS = 1000;
const PASTE_TOKEN = /\[Pasted text #(\d+)(?: \+\d+ lines|, \d+ chars)\]/g;
function pasteToken(id, value) {
  const lines = value.split('\n').length;
  return '[Pasted text #' + id + (lines > 1 ? ' +' + lines + ' lines' : ', ' + value.length + ' chars') + ']';
}
/** Replaces paste placeholders in `text` with the text they stand for. */
export function expandPastes(text, pastes) {
  if (!pastes || !text.includes('[Pasted text #')) return text;
  return text.replace(PASTE_TOKEN, (token, id) => (pastes[id] !== undefined && pasteToken(id, pastes[id]) === token ? pastes[id] : token));
}
// The placeholder that ends at `end` (or starts at `start`), as [from, to].
function pasteTokenAt(state, { end, start }) {
  if (!state.pastes) return null;
  for (const match of state.text.matchAll(PASTE_TOKEN)) {
    const from = match.index;
    const to = from + match[0].length;
    if ((end === to || start === from) && state.pastes[match[1]] !== undefined && pasteToken(match[1], state.pastes[match[1]]) === match[0]) return [from, to];
  }
  return null;
}
function insertPaste(state, value) {
  if (!state.pastes || (value.split('\n').length <= PASTE_MIN_LINES && value.length < PASTE_MIN_CHARS)) return insertText(state, value);
  const id = String((state.pasteCount || 0) + 1);
  return insertText({ ...state, pasteCount: Number(id), pastes: { ...state.pastes, [id]: value } }, pasteToken(id, value));
}

function insertText(state, value) {
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
    case 'paste': return { state: insertPaste(state, key.text.replace(/\t/g, '    ')), action: null };
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
      const token = pasteTokenAt(state, { end: cursor });
      if (token) return { state: withText(state, text.slice(0, token[0]) + text.slice(cursor), token[0]), action: null };
      const start = prevBoundary(text, cursor);
      return { state: withText(state, text.slice(0, start) + text.slice(cursor), start), action: null };
    }
    case 'delete': {
      if (cursor >= text.length) return { state, action: null };
      const token = pasteTokenAt(state, { start: cursor });
      if (token) return { state: withText(state, text.slice(0, cursor) + text.slice(token[1]), cursor), action: null };
      return { state: withText(state, text.slice(0, cursor) + text.slice(nextBoundary(text, cursor)), cursor), action: null };
    }
    case 'ctrlD': {
      if (!text) return { state, action: 'eof' };
      if (cursor >= text.length) return { state, action: null };
      return { state: withText(state, text.slice(0, cursor) + text.slice(nextBoundary(text, cursor)), cursor), action: null };
    }
    case 'left': return { state: { ...state, cursor: prevBoundary(text, cursor) }, action: null };
    case 'right': return { state: { ...state, cursor: nextBoundary(text, cursor) }, action: null };
    case 'wordLeft': return { state: { ...state, cursor: wordBackward(text, cursor) }, action: null };
    case 'wordRight': return { state: { ...state, cursor: wordForward(text, cursor) }, action: null };
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
      const start = spaceWordLeft(text, cursor);
      return { state: { ...withText(state, text.slice(0, start) + text.slice(cursor), start), killRing: text.slice(start, cursor) }, action: null };
    }
    case 'deleteWord': {
      const end = wordForward(text, cursor);
      return { state: { ...withText(state, text.slice(0, cursor) + text.slice(end), cursor), killRing: text.slice(cursor, end) }, action: null };
    }
    case 'yank': return state.killRing ? { state: insertText(state, state.killRing), action: null } : { state, action: 'bell' };
    case 'undo': {
      const last = state.undo[state.undo.length - 1];
      if (!last) return { state, action: 'bell' };
      return { state: { ...state, text: last.text, cursor: last.cursor, undo: state.undo.slice(0, -1) }, action: null };
    }
    case 'up': {
      const { lineStart } = lineInfo(text, cursor);
      if (lineStart > 0) {
        const prev = lineInfo(text, lineStart - 1);
        return { state: { ...state, cursor: indexAtColumn(text, prev.lineStart, prev.lineEnd, columnOf(text, lineStart, cursor)) }, action: null };
      }
      if (state.historyIndex <= 0) return { state, action: 'bell' };
      const draft = state.historyIndex === state.history.length ? text : state.draft;
      const index = state.historyIndex - 1;
      const value = state.history[index];
      return { state: { ...state, historyIndex: index, draft, text: value, cursor: value.length }, action: null };
    }
    case 'down': {
      const { lineStart, lineEnd } = lineInfo(text, cursor);
      if (lineEnd < text.length) {
        const next = lineInfo(text, lineEnd + 1);
        return { state: { ...state, cursor: indexAtColumn(text, next.lineStart, next.lineEnd, columnOf(text, lineStart, cursor)) }, action: null };
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

// The history entry Ctrl+R currently matches, with the cursor at the match.
export function searchPreview(state) {
  const search = state.search;
  if (!search || search.match < 0) return null;
  const text = state.history[search.match] || '';
  const at = text.toLowerCase().indexOf(search.query.toLowerCase());
  return { text, cursor: at < 0 ? text.length : at };
}

// Replaces text[start, end) with value and moves the cursor after it.
function applyCompletion(state, { start, end }, value) {
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

// Where text ends when the terminal wraps it at `cols`: { row, col }, with
// col === cols meaning the row is exactly full. A wide (CJK, emoji) character
// that does not fit in the last cell moves whole to the next row, as
// terminals draw it, leaving that cell empty.
function wrapEnd(text, cols) {
  if (PRINTABLE_ASCII.test(text)) {
    const width = text.length;
    if (width === 0) return { row: 0, col: 0 };
    return { row: Math.floor((width - 1) / cols), col: ((width - 1) % cols) + 1 };
  }
  let row = 0;
  let col = 0;
  for (const { segment } of graphemes.segment(text)) {
    const w = stringWidth(segment);
    if (!w) continue;
    if (col + w > cols) { row += 1; col = 0; }
    col += w;
  }
  return { row, col };
}

// ---------------------------------------------------------------------------
// Layout: computes the frame to draw and where the cursor sits, accounting for
// wrapping at the terminal width.

// maxLines caps how many input lines are drawn. A frame taller than the
// terminal cannot be redrawn in place (cursor-up stops at the top row), so a
// 400-line paste used to fill the screen and be reprinted into the scrollback
// on every keystroke. Longer input shows a window around the cursor with
// "N more lines above/below" markers; the text itself is unchanged.
export function layoutFrame({ prompt, continuation, text, cursor, hints = [], columns = 80, maxLines = Infinity }) {
  const cols = Math.max(10, columns || 80);
  const allLines = text.split('\n');
  const before = text.slice(0, cursor).split('\n');
  let cursorLine = before.length - 1;
  const cursorText = before[cursorLine];
  let bodies = allLines.map((body, index) => ({ prefix: index ? continuation : prompt, body }));
  const limit = Math.max(3, Math.floor(maxLines));
  if (allLines.length > limit) {
    const shown = limit - 2;
    const start = Math.max(0, Math.min(cursorLine - Math.floor(shown / 2), allLines.length - shown));
    const end = start + shown;
    const marker = (count, where) => ({ prefix: continuation, body: '[' + count + ' more line' + (count === 1 ? '' : 's') + ' ' + where + ']' });
    bodies = [
      ...(start > 0 ? [{ ...marker(start, 'above'), prefix: prompt }] : []),
      ...bodies.slice(start, end),
      ...(end < allLines.length ? [marker(allLines.length - end, 'below')] : [])
    ];
    if (start > 0) cursorLine = cursorLine - start + 1;
  }
  const segments = [
    ...bodies,
    ...hints.map((hint) => ({ prefix: '', body: truncateToWidth(hint, cols - 1) }))
  ];
  let out = '';
  let row = 0;
  let cursorRow = 0;
  let cursorCol = 0;
  let endRow = 0;
  segments.forEach((segment, index) => {
    const prefix = stripAnsi(segment.prefix);
    if (index === cursorLine) {
      const at = wrapEnd(prefix + stripAnsi(cursorText), cols);
      // At the right edge the cursor sits at the start of the next row.
      cursorRow = row + at.row + (at.col === cols ? 1 : 0);
      cursorCol = at.col === cols ? 0 : at.col;
    }
    const end = wrapEnd(prefix + stripAnsi(segment.body), cols);
    out += segment.prefix + segment.body;
    if (index < segments.length - 1) {
      out += '\r\n';
      row += end.row + 1;
    } else {
      if (end.col === cols) out += '\r\n';
      endRow = row + end.row + (end.col === cols ? 1 : 0);
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
  '  Alt+V dictate (after /voice on): press to record, again to transcribe into the prompt',
  '  Rebind keys in ~/.claude/keybindings.json or ~/.oasis/keybindings.json (/keybindings)'
];

// Kitty keyboard protocol, level 1 (disambiguate escape codes), as Codex and
// Gemini CLI do: Shift+Enter, Ctrl+Enter and Alt+keys arrive as distinct
// CSI-u keys and Esc needs no timeout. Support is asked once (CSI ? u, with
// DA1 as a sentinel for terminals that do not know it); the flags are pushed
// while the prompt is open and popped when it closes, so a shell command,
// $EDITOR or a crash never inherits them. OASIS_KITTY_KEYBOARD=0 turns it off.
export const kittyKeyboard = { supported: null, pushed: null };
const KITTY_PUSH = '\x1b[>1u';
const KITTY_POP = '\x1b[<u';
function kittyAllowed(env) {
  if (/^(?:0|false|no|off)$/i.test(String(env.OASIS_KITTY_KEYBOARD || ''))) return false;
  return !['dumb', 'linux'].includes(String(env.TERM || '')) && env.OASIS_AX_SCREEN_READER !== '1';
}
function popKittyOnExit() {
  const output = kittyKeyboard.pushed;
  if (output) { try { output.write(KITTY_POP); } catch {} kittyKeyboard.pushed = null; }
}

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
    if (options.collapsePastes !== false) state.pastes = {};
    if (options.vim) state.vim = createVimState(options.vim === 'normal' ? 'normal' : 'insert');
    let hints = [];
    let previousCursorRow = 0;
    let lastCtrlC = 0;
    let lastEscape = 0;
    let completion = null; // { range, candidates, index }
    // The live slash/@ menu shown while typing: ↑/↓ pick an entry, Enter or
    // Tab takes it, Esc closes it (as in Claude Code, Codex and Cursor).
    let liveMenu = null; // { kind, start, end, candidates, selected }
    let palette = null;
    let paletteScreen = false;
    let busy = Promise.resolve();
    let done = false;
    const enqueue = (keys) => { for (const key of keys) busy = busy.then(() => (done ? null : handle(key))); };
    const env = options.env || process.env;
    const useKitty = options.kittyKeyboard !== false && kittyAllowed(env);
    const pushKitty = () => {
      if (kittyKeyboard.pushed || done) return;
      output.write(KITTY_PUSH);
      kittyKeyboard.pushed = output;
      setKittyProtocolActive(true);
    };
    const popKitty = () => {
      if (kittyKeyboard.pushed !== output) return;
      output.write(KITTY_POP);
      kittyKeyboard.pushed = null;
      setKittyProtocolActive(false);
    };
    const onReply = (seq) => {
      if (/u$/.test(seq)) { kittyKeyboard.supported = true; if (useKitty) pushKitty(); }
      else if (kittyKeyboard.supported === null) kittyKeyboard.supported = false;
    };
    const decoder = new KeyDecoder({ onKeys: enqueue, onReply });
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
      // While Ctrl+R searches, the prompt previews the matching history entry
      // with the cursor on the match, as in bash and zsh.
      const view = !final ? searchPreview(state) : null;
      const shownText = view ? view.text : state.text;
      const shownCursor = final ? state.text.length : view ? view.cursor : state.cursor;
      const frame = layoutFrame({ prompt: promptText(), continuation: continuation(), text: shownText, cursor: shownCursor, hints: rows, columns: columns(), maxLines: Math.max(3, (output.rows || 24) - rows.length - 3) });
      let s = '';
      if (previousCursorRow > 0) s += '\x1b[' + previousCursorRow + 'A';
      s += '\r\x1b[J' + frame.out;
      const up = frame.endRow - frame.cursorRow;
      if (up > 0) s += '\x1b[' + up + 'A';
      s += '\r';
      if (frame.cursorCol > 0) s += '\x1b[' + frame.cursorCol + 'C';
      // A redraw that moves up and rewrites several rows is shown in one
      // piece (DEC mode 2026, synchronized output) so the box never flickers
      // half-drawn. Terminals without it ignore the two codes.
      const multi = previousCursorRow > 0 || frame.endRow > 0;
      output.write(multi && SYNC_OUTPUT ? SYNC_BEGIN + s + SYNC_END : s);
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
      if (result.type === 'submit' && typeof result.text === 'string') result = { ...result, text: expandPastes(result.text, state.pastes) };
      cancelRecording();
      hints = [];
      if (paletteScreen) { output.write('\x1b[?1049l'); paletteScreen = false; palette = null; }
      if (result.type === 'submit') draw(true);
      else { state = { ...state, text: '' }; draw(true); }
      output.write('\r\n\x1b[?2004l');
      popKitty();
      input.off('data', onData);
      decoder.destroy();
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
        writeFileSync(file, expandPastes(state.text, state.pastes), 'utf8');
        input.off('data', onData);
        try { input.setRawMode(false); } catch {}
        output.write('\r\n\x1b[?2004l');
        const hadKitty = kittyKeyboard.pushed === output;
        popKitty();
        const run = spawnSync(editor + ' ' + JSON.stringify(file), { stdio: 'inherit', shell: true });
        try { input.setRawMode(true); } catch {}
        output.write('\x1b[?2004h');
        if (hadKitty) pushKitty();
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

    // Voice dictation: the first press starts recording, the next one stops it and inserts
    // the transcript at the cursor (it is not sent until you press Enter). Esc cancels.
    let recording = null;
    const voiceKeyLabel = (sequence) => String(sequence || 'meta+v').split('+').map((part) => part === 'meta' ? 'Alt' : part.length === 1 ? part.toUpperCase() : part[0].toUpperCase() + part.slice(1)).join('+');
    const toggleVoice = async (sequence) => {
      const voice = options.voice;
      if (!voice || !voice.enabled()) { hints = [DIM('Voice dictation is off. Turn it on with /voice on.', color)]; return; }
      const module = await import('./voice.mjs');
      if (!recording) {
        try {
          recording = await (voice.startRecording || module.startRecording)({ env: options.env || process.env });
          hints = [DIM('● Recording · ' + voiceKeyLabel(sequence) + ' to stop and transcribe · Esc to cancel', color)];
        } catch (error) { recording = null; hints = [DIM(error.message, color)]; }
        return;
      }
      const active = recording;
      recording = null;
      hints = [DIM('Transcribing…', color)];
      draw();
      try {
        const file = await active.stop();
        const text = await (voice.transcribe || module.transcribe)(file, { settings: voice.settings ? voice.settings() : {}, env: options.env || process.env, hints: voice.hints ? voice.hints() : [] });
        if (!text) { hints = [DIM('No speech was recognised.', color)]; return; }
        const before = state.text.slice(0, state.cursor);
        const after = state.text.slice(state.cursor);
        const insert = (before && !/\s$/.test(before) ? ' ' : '') + text + (after && !/^\s/.test(after) ? ' ' : '');
        state = { ...state, text: before + insert + after, cursor: before.length + insert.length, undo: [...state.undo.slice(-49), { text: state.text, cursor: state.cursor }] };
        hints = [];
      } catch (error) {
        hints = [DIM(error.message, color)];
      } finally {
        if (active.cleanup) await active.cleanup().catch(() => {});
      }
    };
    const cancelRecording = () => { if (recording) { const active = recording; recording = null; active.cancel().catch(() => {}); return true; } return false; };

    // Maps a key through keybindings.json. Returns the key to apply, or null when consumed.
    const bindKey = async (key) => {
      if (recording && key.name === 'escape') { cancelRecording(); hints = [DIM('Recording cancelled.', color)]; return null; }
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
        if (state.text.trim()) { stash.text = expandPastes(state.text, state.pastes); state = { ...state, text: '', cursor: 0, undo: [...state.undo, { text: state.text, cursor: state.cursor }] }; hints = [DIM('Prompt stashed; it comes back after your next message (Ctrl+S on an empty prompt restores it now).', color)]; }
        else if (stash.text) { state = { ...state, text: stash.text, cursor: stash.text.length }; stash.text = ''; hints = []; }
        else output.write('\x07');
        return null;
      }
      if (effect.action === 'redraw') { output.write('\x1b[2J\x1b[H'); previousCursorRow = 0; return null; }
      if (effect.action === 'voice') { await toggleVoice(sequence); return null; }
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
    const liveMenuKey = (key) => {
      if (!liveMenu || state.search || (state.vim && state.vim.mode === 'normal')) return false;
      const count = Math.min(8, liveMenu.candidates.length);
      if (!count) return false;
      if (key.name === 'down' || key.name === 'up') {
        const step = key.name === 'down' ? 1 : -1;
        liveMenu.selected = liveMenu.selected < 0 ? (step > 0 ? 0 : count - 1) : (liveMenu.selected + step + count) % count;
        hints = [hints[0], ...renderCandidates(liveMenu.candidates, liveMenu.selected, color)];
        draw();
        return true;
      }
      if ((key.name === 'enter' || key.name === 'tab') && liveMenu.selected >= 0) {
        const candidate = liveMenu.candidates[liveMenu.selected];
        const menu = liveMenu;
        liveMenu = null;
        hints = [];
        const value = candidate.value + (candidate.value.endsWith('/') || candidate.noSpace ? '' : ' ');
        if (menu.kind === 'command' && key.name === 'enter' && !candidate.value.endsWith('/') && !candidate.takesArgument) {
          state = applyCompletion(state, { start: menu.start, end: menu.end }, candidate.value);
          finish({ type: 'submit', text: state.text });
          return true;
        }
        state = applyCompletion(state, { start: menu.start, end: menu.end }, value);
        draw();
        return true;
      }
      if (key.name === 'escape' && liveMenu.selected >= 0) {
        liveMenu = null;
        hints = [];
        draw();
        return true;
      }
      return false;
    };
    const handle = async (rawKey) => {
      if (pager) { pagerKey(rawKey); return; }
      if (palette) { paletteKey(rawKey); return; }
      if (liveMenuKey(rawKey)) return;
      const key = await bindKey(rawKey);
      if (done) return;
      if (!key) { if (palette) drawPalette(); else draw(); return; }
      if (key.name !== 'tab') completion = null;
      if (key.name !== 'ctrlC') lastCtrlC = 0;
      const wasHinting = hints.length > 0;
      let outcome = state.vim && !state.search ? applyVimKey(state, key) : null;
      if (outcome && outcome.rest) {
        const typed = applyKey(outcome.state, { name: 'char', text: outcome.rest });
        outcome = { state: trackInsert(outcome.state, typed.state), action: outcome.action || typed.action };
      }
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
      if (!done) {
        // Keep the small slash-command menu visible while a command name is typed.
        // Tab still performs the existing completion; Enter still submits the prompt.
        const commandPrefix = state.text.startsWith('/') && !/\s/.test(state.text) && state.cursor === state.text.length;
        // The same live list for an @file mention being typed (like Claude Code
        // and Cursor): "explain @ad" shows matching files before Tab.
        const beforeCursor = state.text.slice(0, state.cursor);
        const mentionPrefix = !commandPrefix && /(?:^|\s)@[^\s@]*$/.test(beforeCursor) && !/^\S/.test(state.text.slice(state.cursor));
        const MENU_HINT = /^(?:Slash commands|Files) · Tab to complete/;
        if ((commandPrefix || mentionPrefix) && options.complete && !completion && action !== 'escape' && action !== 'submit') {
          try {
            const result = await options.complete(state.text, state.cursor);
            if (result && result.candidates && result.candidates.length) {
              liveMenu = { kind: commandPrefix ? 'command' : 'file', start: result.start ?? 0, end: result.end ?? state.cursor, candidates: result.candidates, selected: -1 };
              hints = [DIM((commandPrefix ? 'Slash commands' : 'Files') + ' · Tab to complete · ↑↓ to pick · type to filter', color), ...renderCandidates(result.candidates, -1, color)];
            } else { liveMenu = null; hints = []; }
          } catch { liveMenu = null; hints = []; }
        } else {
          liveMenu = null;
          if (!commandPrefix && !mentionPrefix && !completion && hints.length && hints[0] && MENU_HINT.test(stripAnsi(hints[0]))) hints = [];
        }
        draw();
      }
    };

    const onData = (chunk) => {
      enqueue(decoder.feed(chunk.toString('utf8')));
    };
    const onResize = () => { if (!done) { if (pager) drawPager(); else draw(); } };

    try { input.setRawMode(true); } catch {}
    input.setEncoding && input.setEncoding('utf8');
    input.resume();
    input.on('data', onData);
    output.on && output.on('resize', onResize);
    output.write('\x1b[?2004h');
    if (useKitty) {
      if (kittyKeyboard.supported) pushKitty();
      // Asked again at each prompt until the terminal answers.
      else if (kittyKeyboard.supported === null) output.write('\x1b[?u\x1b[c');
    }
    if (!popKittyOnExit.installed) { popKittyOnExit.installed = true; process.once('exit', popKittyOnExit); }
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
    if (index !== selected) return '  ' + label + description;
    return color ? '\x1b[7m' + stripAnsi('› ' + label) + '\x1b[27m' + description : '› ' + label + description;
  });
  if (candidates.length > shown.length) lines.push(DIM('  … ' + (candidates.length - shown.length) + ' more (keep typing to narrow)', color));
  return lines;
}
