import test from 'node:test';
import assert from 'node:assert/strict';
import { stringWidth, truncateToWidth, stripAnsi } from '../src/line-editor.mjs';

test('terminal width counts emoji, ZWJ sequences and Indic clusters like a terminal', () => {
  assert.equal(stringWidth('🚀'), 2);
  assert.equal(stringWidth('✅ done'), 7);
  assert.equal(stringWidth('👨‍👩‍👧'), 2);
  assert.equal(stringWidth('👍🏽'), 2);
  assert.equal(stringWidth('हिन्दी'), 4);
  assert.equal(stringWidth('中文'), 4);
  assert.equal(stringWidth('\x1b[31mred\x1b[0m'), 3);
  assert.equal(stripAnsi('\x1b]8;;https://example.com\x07link\x1b]8;;\x07'), 'link');
  assert.equal(truncateToWidth('👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧', 5), '👨‍👩‍👧👨‍👩‍👧…');
});
