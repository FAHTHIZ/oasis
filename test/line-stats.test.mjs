import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineStats, formatLineStats } from '../src/line-stats.mjs';

test('line stats count what an edit added and removed', () => {
  assert.deepEqual(lineStats(null, 'a\nb\nc\n'), { added: 3, removed: 0 });
  assert.deepEqual(lineStats('a\nb\nc\n', 'a\nB\nc\n'), { added: 1, removed: 1 });
  assert.deepEqual(lineStats('a\nb\nc\n', 'a\nb\nx\ny\nc\n'), { added: 2, removed: 0 });
  assert.deepEqual(lineStats('a\nb\nc\nd\n', 'a\nd\n'), { added: 0, removed: 2 });
  assert.deepEqual(lineStats('x\n1\n2\n3\ny\n', 'x\n2\n1\n3\ny\n'), { added: 1, removed: 1 });
  assert.deepEqual(lineStats('same', 'same'), { added: 0, removed: 0 });
  assert.deepEqual(lineStats('a\r\nb\r\n', 'a\nb\n'), { added: 0, removed: 0 });
});

test('formatLineStats reads like a diffstat', () => {
  assert.equal(formatLineStats({ added: 12, removed: 3 }), '+12 −3');
  assert.equal(formatLineStats({ added: 4, removed: 0 }), '+4');
  assert.equal(formatLineStats({ added: 0, removed: 0 }), '');
});
