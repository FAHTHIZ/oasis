import test from 'node:test';
import assert from 'node:assert/strict';
test('rendered prose wraps at word boundaries with aligned continuation rows', async () => {
  const { wrapRendered, MarkdownStream } = await import('../src/markdown.mjs');
  const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');
  const wrapped = strip(wrapRendered('\x1b[1mFound it.\x1b[22m the date-only string parses as UTC midnight so the task turns overdue early', 40, { offset: 2 }));
  for (const row of wrapped.split('\n')) assert.ok(row.length <= 39, row);
  assert.ok(wrapped.split('\n').slice(1).every((row) => row.startsWith('  ')), wrapped);
  const words = wrapped.split(/\s+/).filter(Boolean);
  assert.deepEqual(words, 'Found it. the date-only string parses as UTC midnight so the task turns overdue early'.split(' '));
  assert.equal(wrapRendered('short line', 80), 'short line');
  const bullets = wrapRendered('• src/dates.mjs — one-line root-cause fix and more words to make it wrap', 40);
  assert.ok(bullets.split('\n')[1].startsWith('  '), bullets);
  const chunks = [];
  const stream = new MarkdownStream({ write: (c) => chunks.push(c), color: false, columns: () => 30 });
  stream.push('```\nconst a = "a very long code line that must not be wrapped at all";\n```\n');
  stream.end();
  assert.ok(chunks.join('').includes('const a = "a very long code line that must not be wrapped at all";'));
});
