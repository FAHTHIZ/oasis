// Talk mode: a hands-free voice conversation with the agent. OASIS listens, sends what
// you said when you stop talking, works on it, reads the reply aloud and listens again.
// This module holds the parts that don't need a browser, so they can be tested.

import { Lexer } from 'marked';

/** Plain words of inline Markdown tokens: links read as their text (bare URLs as "a link"). */
function spokenInline(tokens = []) {
  let out = '';
  for (const token of tokens) {
    if (token.type === 'link') out += token.autolink || /^https?:\/\//.test(token.text) ? 'a link' : spokenInline(token.tokens);
    else if (token.type === 'image') out += token.text;
    else if (token.type === 'codespan') out += token.text;
    else if (token.type === 'br') out += '\n';
    else if (token.type === 'html') continue;
    else if (token.tokens) out += spokenInline(token.tokens);
    else out += token.text || '';
  }
  return out;
}

/** Spoken lines of block tokens: code is announced, tables and raw HTML are skipped. */
function spokenBlocks(tokens = [], lines = []) {
  for (const token of tokens) {
    if (token.type === 'code') lines.push('(code omitted)');
    else if (token.type === 'list') for (const item of token.items) spokenBlocks(item.tokens, lines);
    else if (token.type === 'blockquote') spokenBlocks(token.tokens, lines);
    else if (token.type === 'table' || token.type === 'html' || token.type === 'space' || token.type === 'hr') continue;
    else lines.push(spokenInline(token.tokens || [{ type: 'text', text: token.text || '' }]));
  }
  return lines;
}

/**
 * A chat reply made suitable for reading aloud, from marked's Markdown tokens:
 * code blocks are announced, links read as their text, bare URLs as "a link",
 * tables and markup are dropped, and long replies stop at a sentence boundary.
 */
// Models often open a fence mid-line ("Fixed it. ```js\nx\n```"). CommonMark
// reads that as paragraph text, so the backticks and code would be spoken; move
// such a fence onto its own line first so it is announced as code instead.
const INLINE_FENCE = /([^\n])[ \t]*((?:`{3,}|~{3,})[\w+#.-]*[ \t]*\n)/g;

export function speakable(markdown, limit = 900, more = 'The rest is on screen.') {
  const source = String(markdown || '').replace(INLINE_FENCE, '$1\n$2');
  const text = spokenBlocks(Lexer.lex(source, { gfm: true }))
    .join('\n').replace(/\s*\n\s*/g, '\n').replace(/[ \t]{2,}/g, ' ').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf('\n'));
  return (end > limit * 0.5 ? cut.slice(0, end + 1) : cut).trim() + ' ' + more;
}

/** Phrases that end the conversation instead of being sent. */
export function isStopPhrase(text) {
  return /^(?:ok(?:ay)?[, ]+)?(?:stop talking|stop listening|end (?:the )?(?:conversation|call|talk)|that'?s all|goodbye|bye(?: oasis)?)[.!]?$/i.test(String(text || '').trim());
}

/**
 * Decides when a spoken turn is over from microphone loudness samples (0..1 RMS),
 * for browsers without speech recognition that record and transcribe instead.
 * push(level, now) returns 'listening', 'done' (speech then silence, or too long)
 * or 'nothing' (no speech heard in time).
 */
export function turnDetector({ threshold = 0.035, silenceMs = 1300, noSpeechMs = 9000, maxMs = 45000, start = 0 } = {}) {
  let began = start;
  let heard = false;
  let quietSince = null;
  return {
    get heard() { return heard; },
    push(level, now) {
      if (began === null || began === undefined) began = now;
      if (now - began > maxMs) return heard ? 'done' : 'nothing';
      if (level >= threshold) { heard = true; quietSince = null; return 'listening'; }
      if (!heard) return now - began > noSpeechMs ? 'nothing' : 'listening';
      if (quietSince === null) quietSince = now;
      return now - quietSince >= silenceMs ? 'done' : 'listening';
    }
  };
}

/** Root-mean-square loudness of a time-domain sample buffer (bytes centred on 128). */
export function rmsLevel(samples) {
  if (!samples || !samples.length) return 0;
  let sum = 0;
  for (const value of samples) { const centred = (value - 128) / 128; sum += centred * centred; }
  return Math.sqrt(sum / samples.length);
}

/** The text of the agent's last reply in this turn, from the chat's display entries. */
export function lastReply(display) {
  const entries = Array.isArray(display) ? display : [];
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.role === 'user') break;
    if (entry.role === 'assistant' && String(entry.content || '').trim()) return String(entry.content);
    if (entry.role === 'error' && String(entry.content || '').trim()) return 'Something went wrong: ' + String(entry.content);
  }
  return '';
}

// What to tell the person when the microphone cannot be used. Every failure
// used to read "Microphone access is blocked", which sent people with no
// microphone, or a browser without a speech service, to permission settings
// that were already fine. `purpose` is "dictate" or "talk".
//   error:      a getUserMedia DOMException (or its name), or a
//               SpeechRecognition error code ("not-allowed", "audio-capture", …)
//   permission: the microphone permission state when known ("granted", …)
export function micProblem(error, purpose = 'dictate', permission = '') {
  const code = String((error && (error.name || error.error)) || error || '');
  const to = 'to ' + purpose;
  if (code === 'NotFoundError' || code === 'OverconstrainedError' || code === 'DevicesNotFoundError' || code === 'audio-capture') return 'No microphone was found. Connect one and try again ' + to + '.';
  if (code === 'NotReadableError' || code === 'TrackStartError' || code === 'AbortError') return 'The microphone could not start; another app may be using it.';
  if (code === 'service-not-allowed') return 'This browser\u2019s speech recognition is not available. Try Chrome or Edge, or set up a transcription service (/voice in the terminal).';
  if (code === 'network') return 'Speech recognition needs a network connection; check it and try again.';
  if (code === 'NotAllowedError' || code === 'SecurityError' || code === 'PermissionDeniedError' || code === 'not-allowed') {
    // The browser reports not-allowed even with permission granted when it has
    // no microphone or speech service to give the page.
    if (permission === 'granted') return 'The microphone is allowed but could not be used ' + to + '. Check that one is connected, or try another browser.';
    return 'Microphone access is blocked. Allow it in the browser ' + to + '.';
  }
  return 'The microphone could not be used' + (code ? ' (' + code + ')' : '') + '.';
}

export async function micPermission(nav = globalThis.navigator) {
  try { return (await nav.permissions.query({ name: 'microphone' })).state || ''; } catch { return ''; }
}
