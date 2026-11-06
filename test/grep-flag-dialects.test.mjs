import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { grepWorkspace } from '../src/power-tools.mjs';

async function tree() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-grepflags-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'a.py'), 'one\nTwo Needle\nthree\nfour\n');
  await writeFile(path.join(root, 'src', 'b.js'), 'alpha\nneedle beta\ngamma\n');
  await writeFile(path.join(root, 'src', 'c.js'), 'needle c1\nneedle c2\nneedle c3\n');
  return root;
}

for (const forceFallback of [false, true]) {
  const engine = forceFallback ? 'builtin' : 'ripgrep';
  test('grep honours Claude Code style flags (' + engine + ')', async () => {
    const root = await tree();
    const opts = { forceFallback };
    const ci = await grepWorkspace(root, { pattern: 'needle', '-i': true, output_mode: 'files_with_matches' }, opts);
    assert.equal(ci.engine, engine);
    assert.deepEqual(ci.results.sort(), ['src/a.py', 'src/b.js', 'src/c.js']);
    const typed = await grepWorkspace(root, { pattern: 'needle', '-i': true, type: 'py', output_mode: 'files_with_matches' }, opts);
    assert.deepEqual(typed.results, ['src/a.py']);
    const ctx = await grepWorkspace(root, { pattern: 'Needle', path: 'src/a.py', '-B': 1, '-A': 2 }, opts);
    assert.deepEqual(ctx.results.map((l) => l.replace(/^.*?a\.py[:-]/, '')), ['1-one', '2:Two Needle', '3-three', '4-four']);
    const page1 = await grepWorkspace(root, { pattern: 'needle', path: 'src/c.js', head_limit: 2 }, opts);
    assert.equal(page1.results.length, 2);
    assert.equal(page1.truncated, true);
    const page2 = await grepWorkspace(root, { pattern: 'needle', path: 'src/c.js', limit: 2, offset: 2 }, opts);
    assert.deepEqual(page2.results.map((l) => l.replace(/^.*?c\.js:/, '')), ['3:needle c3']);
    assert.equal(page2.truncated, false);
  });
}

test('grep rejects malformed type names and explains unknown ones', async () => {
  const root = await tree();
  await assert.rejects(() => grepWorkspace(root, { pattern: 'x', type: 'js; rm -rf /' }), /ripgrep file type name/);
  await assert.rejects(() => grepWorkspace(root, { pattern: 'x', type: 'nosuchtype' }), /type/i);
  await assert.rejects(() => grepWorkspace(root, { pattern: 'x', type: 'nosuchtype' }, { forceFallback: true }), /not known without ripgrep/);
});
