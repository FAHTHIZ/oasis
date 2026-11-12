import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapTerminalText } from '../src/term-wrap.mjs';

test('report lines wrap between words with a hanging indent', () => {
  const line = '  Local model fit: up to qwen3:4b-instruct-2507-q4_K_M (about 3.3 GB usable); run oasis setup --auto';
  const out = wrapTerminalText(line, 69).split('\n');
  assert.ok(out.length > 1);
  for (const row of out) assert.ok(row.length <= 69, row);
  assert.match(out[1], /^ {4}\S/);
  assert.equal(out.join(' ').replace(/\s+/g, ' ').trim(), line.trim());
  // Short lines, blank lines and narrow widths are untouched.
  assert.equal(wrapTerminalText('a\n\n  b: c', 69), 'a\n\n  b: c');
  assert.equal(wrapTerminalText(line, 10), line);
  // A word longer than the width stays whole on its own line.
  const long = wrapTerminalText('  key: ' + 'x'.repeat(80), 40).split('\n');
  assert.equal(long[1], '    ' + 'x'.repeat(80));
});

test('colour codes do not count toward the width', () => {
  const green = '\x1b[32mok\x1b[0m';
  const text = '  ' + Array.from({ length: 12 }, () => green).join(' ');
  for (const row of wrapTerminalText(text, 20).split('\n')) assert.ok(row.replace(/\x1b\[[0-9;]*m/g, '').length <= 20, row);
});
