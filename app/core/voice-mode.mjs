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
export function speakable(markdown, limit = 900, more = 'The rest is on screen.') {
  const text = spokenBlocks(Lexer.lex(String(markdown || ''), { gfm: true }))
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
