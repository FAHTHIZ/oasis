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

test('terminal inline Markdown follows CommonMark via marked', async () => {
  const { renderInline } = await import('../src/markdown.mjs');
  const plain = (s) => s.replace(/\x1b\]8;;[^\x07]*\x07/g, '').replace(/\x1b\[\d+m/g, '');
  // Nested emphasis and escapes.
  assert.match(renderInline('**b _c_**'), /\x1b\[1mb \x1b\[3mc/);
  assert.equal(plain(renderInline('\\*not italic\\*')), '*not italic*');
  // A URL containing parentheses stays one link.
  const link = renderInline('[w](https://e.com/a_(b))');
  assert.ok(link.includes('\x1b]8;;https://e.com/a_(b)\x07'));
  assert.equal(plain(link), 'w');
  // Code spans keep their content literal.
  assert.equal(plain(renderInline('`a ** b`')), 'a ** b');
});

test('code blocks are highlighted by lowlight grammars with nested colours restored', async () => {
  const { highlightCode } = await import('../src/markdown.mjs');
  // Rust and Go keywords the old keyword list lacked context for; a JS template substitution nests.
  assert.match(highlightCode('fn main() { let v = vec![1]; }', 'rust'), /\x1b\[35mfn\x1b\[39m/);
  const js = highlightCode('const s = `a ${b + 1}`', 'js');
  assert.match(js, /\x1b\[32m`a \x1b\[39m\$\{b \+ \x1b\[33m1\x1b\[39m\}\x1b\[32m`/);
  assert.match(highlightCode('<div class="x">', 'html'), /\x1b\[34mdiv/);
  assert.equal(highlightCode('plain text', 'not-a-language'), 'plain text');
});

test('wrapped rows close and reopen styles so the continuation indent is never colored', async () => {
  const { wrapRendered } = await import('../src/markdown.mjs');
  const wrapped = wrapRendered('\x1b[44mone two three four five six seven eight nine ten eleven\x1b[49m', 30, { offset: 2 });
  const rows = wrapped.split('\n');
  assert.ok(rows.length >= 2);
  assert.ok(rows[0].endsWith('\x1b[49m'), JSON.stringify(rows[0]));
  for (const row of rows.slice(1)) assert.match(row, /^ {2}\x1b\[44m/, JSON.stringify(row));
  assert.equal(wrapped.replace(/\x1b\[[0-9;]*m/g, '').replace(/\n +/g, ' '), 'one two three four five six seven eight nine ten eleven');
});

test('streamed replies that open with blank lines keep the first words next to the bullet', async () => {
  const { MarkdownStream } = await import('../src/markdown.mjs');
  const out = [];
  const stream = new MarkdownStream({ write: (chunk) => out.push(chunk), color: false, columns: () => 80, prefix: '● ' });
  stream.push('\n');
  stream.push('\r\n\nPONG');
  stream.end();
  const text = out.join('');
  assert.doesNotMatch(text, /● \r?\n/, 'the bullet must not sit alone on its line');
  assert.match(text, /● PONG\n$/);
  const indented = [];
  const code = new MarkdownStream({ write: (chunk) => indented.push(chunk), color: false, columns: () => 80, prefix: '● ' });
  code.push('  two leading spaces stay');
  code.end();
  assert.match(indented.join(''), /●   two leading spaces stay\n$/);
});
