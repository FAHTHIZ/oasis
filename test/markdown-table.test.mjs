import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, renderTable, MarkdownStream } from '../src/markdown.mjs';
import { stringWidth } from '../src/line-editor.mjs';

// What a terminal shows: a partial line erased with \r ESC[J is replaced.
const screen = (s) => strip(s).split('\n').map((line) => line.slice(line.lastIndexOf('\r') + 1)).join('\n');
const strip = (s) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\]8;;[^\x07]*\x07/g, '');

test('GFM tables render as one aligned box, sized by display width', () => {
  const out = strip(renderTable(['| Name | Count |', '|:--|--:|', '| 日本語 | 3 |', '| 👍🏽 ok | 12 |', '| `a\\|b` | **x** |'], { columns: 80 }));
  const rows = out.split('\n');
  assert.equal(rows[0], '  ┌────────┬───────┐');
  assert.equal(rows[1], '  │ Name   │ Count │');
  assert.equal(rows[3], '  │ 日本語 │     3 │');
  assert.equal(rows[5], '  │ a|b    │     x │');
  assert.equal(new Set(rows.map((row) => stringWidth(row))).size, 1, out);
});

test('wide tables wrap their cells to the terminal width', () => {
  const long = 'word '.repeat(40).trim();
  const out = strip(renderTable(['| a | b |', '|---|---|', '| short | ' + long + ' |'], { columns: 50 }));
  const rows = out.split('\n');
  assert.ok(rows.length > 6, out);
  assert.ok(rows.every((row) => stringWidth(row) <= 50), out);
  assert.equal(new Set(rows.map((row) => stringWidth(row))).size, 1, out);
});

test('tables inside replies render in full and in a stream, and stay raw without color', () => {
  const md = 'Before\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\nafter';
  assert.match(strip(renderMarkdown(md, { color: true })), /  ┌───┬───┐\n  │ a │ b │/);
  assert.match(renderMarkdown(md, { color: false }), /\| a \| b \|\n\|---\|---\|/);
  const out = [];
  const stream = new MarkdownStream({ write: (t) => out.push(t), color: true, columns: () => 80 });
  for (const ch of md) stream.push(ch);
  stream.end();
  const shown = screen(out.join(''));
  assert.match(shown, /│ 1 │ 2 │/);
  assert.match(shown, /Before\n\n  ┌───┬───┐/);
  assert.match(shown, /  └───┴───┘\n\nafter/);
  // A table at the very end of a reply is flushed by end().
  const tail = [];
  const end = new MarkdownStream({ write: (t) => tail.push(t), color: true, columns: () => 80 });
  end.push('| x |\n|---|\n| y |');
  end.end();
  assert.match(screen(tail.join('')), /│ y │\n  └───┘/);
  // Fenced pipes are code, not a table.
  assert.match(strip(renderMarkdown('```\n| not | a table |\n```', { color: true })), /\| not \| a table \|/);
});
