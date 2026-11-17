// The live region: the few rows at the bottom of the terminal that change
// while a turn runs (the line of the reply still being written, the status
// line, the task checklist), drawn below everything that is final.
//
// Why a compositor instead of each part writing on its own:
//   - one write per frame, wrapped in synchronized output (DEC mode 2026), so
//     the terminal never paints half a frame (no flicker, no tearing);
//   - streamed text, tool lines and status updates arriving in the same
//     frame become one write instead of a few hundred a second;
//   - the cursor is hidden once for the turn, not on every spinner frame;
//   - every row is clipped to the terminal width, so the number of rows to
//     erase is always known exactly (no ghost lines after a long partial
//     line or a resize).
//
// While attached, writes to the stream go through the region: final text is
// queued and written above the live rows at the next frame. A write that does
// not end in a newline (a question, a prompt) is flushed at once and the live
// rows stay hidden until the line is finished, so prompts are never split.
// suspend() hides the region entirely (interactive dialogs draw their own
// rows); resume() brings it back.

import { stringWidth, stripAnsi } from './line-editor.mjs';

const SYNC_BEGIN = '\x1b[?2026h';
const SYNC_END = '\x1b[?2026l';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
const SECTIONS = ['partial', 'gap', 'status', 'todos'];

export function syncOutputSupported(env = process.env) {
  if (/^(?:0|false|no|off)$/i.test(String(env.OASIS_SYNC_OUTPUT || ''))) return false;
  return !['dumb', 'linux'].includes(String(env.TERM || ''));
}

// Cuts an ANSI-styled row to `max` display columns, keeping escape codes.
export function clipRow(row, max) {
  const text = String(row || '');
  if (stringWidth(text) <= max) return text;
  let out = '';
  let width = 0;
  const parts = text.split(/(\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07)/);
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  for (const part of parts) {
    if (!part) continue;
    if (part.startsWith('\x1b')) { out += part; continue; }
    for (const { segment } of segmenter.segment(part)) {
      const w = stringWidth(segment);
      if (width + w > max - 1) return out + '…\x1b[0m';
      out += segment;
      width += w;
    }
  }
  return out;
}

export function createLiveRegion({ stream = process.stdout, mirrors = [], env = process.env, frameMs = 16, timers = { setTimeout, clearTimeout } } = {}) {
  const sync = syncOutputSupported(env);
  const sections = Object.fromEntries(SECTIONS.map((name) => [name, []]));
  let attached = false;
  let suspended = false;
  let original = null;
  const mirrored = [];
  let pending = '';
  let drawnWidths = []; // display widths of the rows on screen now
  let atLineStart = true;
  let timer = null;
  let lastFlush = 0;

  const columns = () => Math.max(20, Number(stream.columns) || 80);
  const rawWrite = (text) => { if (text) original.call(stream, text); };

  // Rows on screen for what was drawn, at today's width (a resize can wrap them).
  const physicalRows = () => {
    const cols = columns();
    return drawnWidths.reduce((sum, width) => sum + Math.max(1, Math.ceil(width / cols)), 0);
  };
  const eraseSequence = () => {
    if (!drawnWidths.length) return '';
    const up = physicalRows() - 1;
    return '\r' + (up > 0 ? '\x1b[' + up + 'A' : '') + '\x1b[J';
  };
  const rows = () => {
    const max = columns() - 1;
    const list = [];
    const body = [...sections.partial, ...sections.status, ...sections.todos];
    if (!body.length) return list;
    for (const name of SECTIONS) {
      if (name === 'gap') { if (sections.partial.length && (sections.status.length || sections.todos.length)) list.push(''); continue; }
      for (const row of sections[name]) list.push(clipRow(row, max));
    }
    return list;
  };

  function flush() {
    if (timer) { timers.clearTimeout(timer); timer = null; }
    if (!attached) return;
    lastFlush = Date.now();
    const visible = !suspended && atLineStart ? rows() : [];
    let out = eraseSequence() + pending;
    pending = '';
    if (visible.length) out += visible.join('\n');
    drawnWidths = visible.map((row) => stringWidth(row));
    if (!out) return;
    rawWrite(sync ? SYNC_BEGIN + out + SYNC_END : out);
  }
  function schedule() {
    if (!attached || timer) return;
    const wait = Math.max(0, frameMs - (Date.now() - lastFlush));
    timer = timers.setTimeout(flush, wait);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  // Everything written while attached lands here.
  function intercept(chunk, encoding, callback) {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString(typeof encoding === 'string' ? encoding : 'utf8') : String(chunk);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (suspended) {
      rawWrite(text);
      if (/[^\x1b]/.test(stripAnsi(text))) atLineStart = /\n$/.test(text);
    } else {
      pending += text;
      const printable = stripAnsi(text);
      if (printable) {
        atLineStart = /\n$/.test(text);
        // A prompt or a half line: show it now, region hidden until the line ends.
        if (!atLineStart) flush(); else schedule();
      } else schedule();
    }
    if (typeof done === 'function') queueMicrotask(done);
    return true;
  }

  const onResize = () => { if (attached) flush(); };

  const region = {
    get attached() { return attached; },
    get suspended() { return suspended; },
    attach() {
      if (attached || !stream.isTTY) return false;
      attached = true;
      suspended = false;
      atLineStart = true;
      original = stream.write;
      stream.write = intercept;
      for (const other of mirrors) {
        if (!other || other === stream || !other.isTTY) continue;
        mirrored.push([other, other.write]);
        other.write = intercept;
      }
      rawWrite(HIDE_CURSOR);
      if (typeof stream.on === 'function') stream.on('resize', onResize);
      return true;
    },
    detach() {
      if (!attached) return;
      for (const name of SECTIONS) sections[name] = [];
      flush();
      if (timer) { timers.clearTimeout(timer); timer = null; }
      rawWrite(SHOW_CURSOR);
      stream.write = original;
      for (const [other, write] of mirrored.splice(0)) other.write = write;
      if (typeof stream.off === 'function') stream.off('resize', onResize);
      attached = false;
      drawnWidths = [];
    },
    // Replace one section's rows (styled strings, one per row).
    set(section, list) {
      if (!SECTIONS.includes(section)) throw new Error('Unknown live region section: ' + section);
      const next = Array.isArray(list) ? list.filter((row) => row !== null && row !== undefined).map(String) : [];
      const prev = sections[section];
      if (prev.length === next.length && prev.every((row, i) => row === next[i])) return;
      sections[section] = next;
      schedule();
    },
    get(section) { return [...(sections[section] || [])]; },
    flush,
    // Hide the live rows (a dialog takes over the bottom of the screen).
    suspend() {
      if (!attached || suspended) return;
      flush();
      const erase = eraseSequence();
      drawnWidths = [];
      if (erase) rawWrite(sync ? SYNC_BEGIN + erase + SYNC_END : erase);
      suspended = true;
      rawWrite(SHOW_CURSOR);
    },
    resume() {
      if (!attached || !suspended) return;
      suspended = false;
      rawWrite(HIDE_CURSOR);
      schedule();
    }
  };
  return region;
}
