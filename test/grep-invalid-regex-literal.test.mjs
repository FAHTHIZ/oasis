import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { grepWorkspace } from '../src/power-tools.mjs';

for (const forceFallback of [false, true]) {
  const engine = forceFallback ? 'builtin' : 'ripgrep';
  test('an invalid regex such as add( is searched as plain text with a note (' + engine + ')', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-grep-literal-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'math.mjs'), 'export function add(a,b){return a-b}\nconst x = add(1, 2);\n');
    const out = await grepWorkspace(root, { pattern: 'add(' }, { forceFallback });
    assert.equal(out.engine, engine);
    assert.equal(out.count, 2);
    assert.match(out.note, /not a valid regular expression, so it was searched as plain text/);
    const valid = await grepWorkspace(root, { pattern: 'add\\(1' }, { forceFallback });
    assert.equal(valid.count, 1);
    assert.equal(valid.note, undefined, 'a valid regex is not reported as retried');
  });
}
