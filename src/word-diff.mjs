// Word-level diff highlights shared by the terminal (src/markdown.mjs) and the
// web app's diff view (app/main.mjs). Browser-safe: imports only jsdiff.
import { diffWordsWithSpace } from 'diff';

// Word-level highlights for a changed line: pairs the i-th removed line of a
// change block with the i-th added line and marks the words that differ, when
// the two lines are similar enough that the highlight helps (Claude Code and
// Cursor show the same). Returns Map(index -> [{ text, changed }]).
// Accepts the terminal's ops ({ op: '-'|'+'|' ', line }) and the web app's
// ({ type: 'del'|'add'|'same'|'note', text }).
const WORD_DIFF_MAX = 400;
const KIND = { del: '-', add: '+' };
const kindOf = (op) => op.op ?? KIND[op.type] ?? ' ';
const textOf = (op) => op.line ?? op.text ?? '';
export function wordHighlights(ops) {
  const out = new Map();
  let index = 0;
  while (index < ops.length) {
    if (kindOf(ops[index]) !== '-') { index += 1; continue; }
    const removed = [];
    while (index < ops.length && kindOf(ops[index]) === '-') removed.push(index++);
    const added = [];
    while (index < ops.length && kindOf(ops[index]) === '+') added.push(index++);
    for (let k = 0; k < Math.min(removed.length, added.length); k += 1) {
      const a = textOf(ops[removed[k]]);
      const b = textOf(ops[added[k]]);
      if (!a.trim() || !b.trim() || a.length > WORD_DIFF_MAX || b.length > WORD_DIFF_MAX) continue;
      const parts = diffWordsWithSpace(a, b);
      const same = parts.filter((part) => !part.added && !part.removed).reduce((sum, part) => sum + part.value.trim().length, 0);
      if (same < 0.4 * Math.max(a.trim().length, b.trim().length)) continue;
      out.set(removed[k], parts.filter((part) => !part.added).map((part) => ({ text: part.value, changed: Boolean(part.removed) })));
      out.set(added[k], parts.filter((part) => !part.removed).map((part) => ({ text: part.value, changed: Boolean(part.added) })));
    }
  }
  return out;
}
