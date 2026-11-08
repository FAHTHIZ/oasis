import test from 'node:test';
import assert from 'node:assert/strict';
import { renderDiff, lineDiff, wordHighlights } from '../src/markdown.mjs';

test('similar changed lines get word-level highlights on the differing words only', () => {
  const highlights = wordHighlights(lineDiff('const answer = 41;', 'const answer = 42;'));
  const removed = highlights.get(0).filter((part) => part.changed).map((part) => part.text);
  const added = highlights.get(1).filter((part) => part.changed).map((part) => part.text);
  assert.deepEqual(removed, ['41']);
  assert.deepEqual(added, ['42']);
});

test('unrelated replacements are shown as whole lines', () => {
  const highlights = wordHighlights(lineDiff('import fs from "node:fs";', 'return total * rate;'));
  assert.equal(highlights.size, 0);
});

test('colored diff marks changed words with the word background; plain text is unchanged', () => {
  const colored = renderDiff('a\nlet x = 1;\nb', 'a\nlet x = 2;\nb');
  assert.ok(colored.text.includes('\x1b[48;5;88m1\x1b[48;5;52m;'));
  assert.ok(colored.text.includes('\x1b[48;5;28m2\x1b[48;5;22m;'));
  const plain = renderDiff('a\nlet x = 1;\nb', 'a\nlet x = 2;\nb', { color: false });
  assert.ok(plain.text.includes('- let x = 1;'));
  assert.ok(plain.text.includes('+ let x = 2;'));
  assert.equal(plain.added, 1);
  assert.equal(plain.removed, 1);
});
