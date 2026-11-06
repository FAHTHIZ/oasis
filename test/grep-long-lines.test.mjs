import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { grepWorkspace } from '../src/power-tools.mjs';

// A minified bundle: one 160,000-character line with the match near the end,
// and a short line after it.
async function tree(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-grep-long-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist'));
  const bundle = 'var a=1;'.repeat(20000) + 'function NeedleHere(){return "é✓"}' + 'x'.repeat(600) + '\nshort NeedleHere line\n';
  await writeFile(path.join(root, 'dist', 'app.min.js'), bundle);
  await writeFile(path.join(root, 'dist', 'early.js'), 'NeedleHere ' + 'y'.repeat(5000) + '\n');
  return root;
}

for (const forceFallback of [false, true]) {
  const engine = forceFallback ? 'builtin' : 'ripgrep';
  test('grep shows the match inside a long minified line, not its first 400 columns (' + engine + ')', async (t) => {
    const root = await tree(t);
    const found = await grepWorkspace(root, { pattern: 'Needle\\w+', path: 'dist/app.min.js' }, { forceFallback });
    assert.equal(found.engine, engine);
    assert.equal(found.results.length, 2);
    const [long, short] = found.results;
    assert.match(long, /^dist\/app\.min\.js:1:…/);
    assert.match(long, /var a=1;function NeedleHere\(\)\{return "é✓"\}x+…/);
    assert.match(long, /\[match at column 160010 of a long line\]$/);
    assert.ok(long.length < 600, 'the window stays small: ' + long.length);
    assert.equal(short, 'dist/app.min.js:2:short NeedleHere line');
  });

  test('a match inside the first columns keeps the ordinary preview (' + engine + ')', async (t) => {
    const root = await tree(t);
    const found = await grepWorkspace(root, { pattern: 'NeedleHere', path: 'dist/early.js', '-i': true }, { forceFallback });
    assert.equal(found.results.length, 1);
    assert.match(found.results[0], /^dist\/early\.js:1:NeedleHere y+/);
    assert.doesNotMatch(found.results[0], /match at column/);
    assert.ok(found.results[0].length <= 520);
  });
}

test('fixed-string and case-insensitive searches window long lines too', async (t) => {
  const root = await tree(t);
  const found = await grepWorkspace(root, { pattern: 'needlehere()', path: 'dist/app.min.js', '-i': true }, { fixedStrings: true });
  assert.equal(found.results.length, 1);
  assert.match(found.results[0], /function NeedleHere\(\)\{/);
  assert.match(found.results[0], /match at column 160010/);
});
