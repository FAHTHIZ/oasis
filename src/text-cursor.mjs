// Cursor positions in prompt text move by grapheme cluster (Intl.Segmenter),
// so an emoji with skin tone or ZWJ, a flag, a Hangul syllable or a letter
// with combining marks is one step for arrows, Backspace and Delete. Word
// motions use pi-tui's Intl.Segmenter word navigation: stops at punctuation
// in paths and splits CJK runs into words. Columns are display columns
// (string-width), so Up/Down keep their place over wide CJK text.
import { findWordBackward, findWordForward } from '@earendil-works/pi-tui/dist/word-navigation.js';
import stringWidth from 'string-width';

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
// Longest cluster we look past; real clusters (ZWJ families, tag flags) are far shorter.
const WINDOW = 64;

function lineStartBefore(text, index) { return text.lastIndexOf('\n', index - 1) + 1; }
function lineEndAfter(text, index) { const end = text.indexOf('\n', index); return end === -1 ? text.length : end; }

export function prevGrapheme(text, index) {
  if (index <= 0) return 0;
  if (text[index - 1] === '\n') return index - 1;
  const from = Math.max(lineStartBefore(text, index), index - WINDOW);
  let last = from;
  for (const { index: at } of graphemes.segment(text.slice(from, index))) last = from + at;
  return last;
}

export function nextGrapheme(text, index) {
  if (index >= text.length) return text.length;
  if (text[index] === '\n') return index + 1;
  const to = Math.min(lineEndAfter(text, index), index + WINDOW);
  const first = graphemes.segment(text.slice(index, to))[Symbol.iterator]().next();
  return first.done ? index + 1 : index + first.value.segment.length;
}

export const wordBackward = (text, index) => findWordBackward(text, index);
export const wordForward = (text, index) => findWordForward(text, index);

// Display width of text[lineStart, index).
export function columnOf(text, lineStart, index) { return stringWidth(text.slice(lineStart, index)); }

// Index in text[lineStart, lineEnd) closest to display column `column`
// without splitting a grapheme or overshooting a wide character.
export function indexAtColumn(text, lineStart, lineEnd, column) {
  let width = 0;
  for (const { segment, index } of graphemes.segment(text.slice(lineStart, lineEnd))) {
    const w = stringWidth(segment);
    if (width + w > column) return lineStart + index;
    width += w;
  }
  return lineEnd;
}

// Cuts plain text to at most `max` display columns, ending in '…' when cut.
export function truncateColumns(text, max) {
  if (stringWidth(text) <= max) return text;
  return text.slice(0, indexAtColumn(text, 0, text.length, Math.max(0, max - 1))) + '…';
}
