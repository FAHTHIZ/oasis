import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
import { spawnSync } from 'node:child_process';
for (const args of [['scripts/check-site.mjs'], ['--test']]) {
  const checked = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8', timeout: 120000 });
  if (checked.error || checked.status !== 0) throw new Error('Existing repository checks failed: ' + String(checked.error || checked.status) + '\n' + String(checked.stdout || '').slice(-4000) + String(checked.stderr || '').slice(-4000));
}
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.equal(m.sliceLines('a\nb\nc'), 'a\nb\nc');
assert.equal(m.sliceLines('a\r\nb\r\nc', 2, 1), 'b');
assert.equal(m.sliceLines('a\nb\nc', 0, 2), 'a\nb');
assert.equal(m.sliceLines('a\nb', 99, 5), '');
