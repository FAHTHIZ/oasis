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
assert.deepEqual(m.validateTodos([{ content: '  Test  ', status: 'pending' }]), [{ content: 'Test', status: 'pending' }]);
assert.throws(() => m.validateTodos('no'), /array/);
assert.throws(() => m.validateTodos([{ content: 'x', status: 'done' }]), /status/);
assert.throws(() => m.validateTodos([{ content: 'a', status: 'in_progress' }, { content: 'b', status: 'in_progress' }]), /Only one/);
assert.throws(() => m.validateTodos(Array.from({ length: 51 }, () => ({ content: 'x', status: 'pending' }))), /50/);
