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

test('code fences show no language label that could be copied as a command', async () => {
  const { MarkdownStream } = await import('../src/markdown.mjs');
  let out = '';
  const stream = new MarkdownStream({ write: (chunk) => { out += chunk; }, color: true, columns: () => 80 });
  stream.push('Run it:\n\n```bash\nnode test.mjs\n```\n');
  stream.end();
  const plain = out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
  assert.doesNotMatch(plain, /^\s*bash\s*$/m);
  assert.match(plain, /node test\.mjs/);
});

test('a notice written mid-stream does not split or repeat the reply', async () => {
  const { MarkdownStream } = await import('../src/markdown.mjs');
  const pyteLike = (raw) => {
    // Minimal terminal: handles \r, \n, ESC[nA, ESC[J.
    const rows = ['']; let r = 0; let c = 0;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '\x1b') {
        const m = /^\x1b\[(\d*)([AJm])/.exec(raw.slice(i));
        if (m) { if (m[2] === 'A') r = Math.max(0, r - Number(m[1] || 1)); if (m[2] === 'J') { rows[r] = rows[r].slice(0, c); rows.length = r + 1; } i += m[0].length - 1; continue; }
      }
      if (ch === '\r') { c = 0; continue; }
      if (ch === '\n') { r++; c = 0; if (rows.length <= r) rows.push(''); continue; }
      rows[r] = rows[r].slice(0, c) + ch + rows[r].slice(c + 1); c++;
    }
    return rows.join('\n');
  };
  let out = '';
  const stream = new MarkdownStream({ write: (chunk) => { out += chunk; }, color: false, columns: () => 80, prefix: '● ' });
  stream.push('word0 word1 ');
  stream.interject('  ↳ sent: note');
  stream.push('word2 word3');
  stream.end();
  const screen = pyteLike(out);
  assert.equal(screen.match(/word0/g).length, 1, screen);
  assert.match(screen, /↳ sent: note\n● word0 word1 word2 word3/);
});
