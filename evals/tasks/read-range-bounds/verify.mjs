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
assert.deepEqual(m.normalizeReadRange(undefined, undefined), { offset: 1, limit: 2000 });
assert.deepEqual(m.normalizeReadRange('3', '12'), { offset: 3, limit: 12 });
assert.deepEqual(m.normalizeReadRange(0, -1), { offset: 1, limit: 1 });
assert.deepEqual(m.normalizeReadRange(8, 50000), { offset: 8, limit: 2000 });
