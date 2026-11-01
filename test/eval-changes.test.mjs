import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { workspaceChanges } from '../src/eval.mjs';

test('eval trials record what the agent added, changed and deleted', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-eval-changes-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const before = path.join(root, 'before');
  const after = path.join(root, 'after');
  for (const dir of [before, after]) { await mkdir(path.join(dir, 'src'), { recursive: true }); await mkdir(path.join(dir, 'node_modules'), { recursive: true }); }
  await writeFile(path.join(before, 'same.txt'), 'x');
  await writeFile(path.join(after, 'same.txt'), 'x');
  await writeFile(path.join(before, 'edit.txt'), 'old');
  await writeFile(path.join(after, 'edit.txt'), 'new');
  await writeFile(path.join(before, 'gone.txt'), 'bye');
  await writeFile(path.join(after, 'src', 'lib.mjs'), 'export function clampInteger(value, min, max, fallback) {}\n');
  await writeFile(path.join(after, 'node_modules', 'dep.js'), 'ignored');
  await writeFile(path.join(after, 'big.txt'), 'y'.repeat(9000));
  const changes = await workspaceChanges(before, after);
  assert.deepEqual(changes.map((change) => change.path + ':' + change.status), ['big.txt:added', 'edit.txt:modified', 'src/lib.mjs:added', 'gone.txt:deleted']);
  assert.match(changes.find((change) => change.path === 'src/lib.mjs').content, /clampInteger\(value, min, max, fallback\)/);
  assert.match(changes[0].content, /\[\.\.\. 3000 more characters\]$/);
});
