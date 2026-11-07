import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, rm } from 'node:fs/promises';
import { executeTool } from '../src/tools.mjs';

// Parallel subagents share one workspace but have separate contexts, so each
// one's own read-before-edit bookkeeping cannot see the other's write.
function agentContext(root) {
  return { root, session: { config: {} }, autoApprove: true, approval: async () => true };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-edit-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'f.txt'), Array.from({ length: 20 }, (_, i) => 'line ' + i).join('\n') + '\n');
  return root;
}

test('concurrent edit_file calls on one file from two agents both land', async (t) => {
  const root = await fixture(t);
  const results = await Promise.all([
    executeTool('edit_file', { path: 'f.txt', old_string: 'line 3\n', new_string: 'LINE THREE\n' }, agentContext(root)),
    executeTool('edit_file', { path: 'f.txt', old_string: 'line 15\n', new_string: 'LINE FIFTEEN\n' }, agentContext(root)),
    executeTool('multi_edit', { path: 'f.txt', edits: [{ old_string: 'line 9\n', new_string: 'LINE NINE\n' }] }, agentContext(root))
  ]);
  assert.ok(results.every((r) => r.changed === true), JSON.stringify(results));
  const text = await readFile(path.join(root, 'f.txt'), 'utf8');
  assert.match(text, /LINE THREE/);
  assert.match(text, /LINE NINE/);
  assert.match(text, /LINE FIFTEEN/, 'no edit is silently lost');
});

test('a failing edit does not block later edits to the same file', async (t) => {
  const root = await fixture(t);
  await assert.rejects(executeTool('edit_file', { path: 'f.txt', old_string: 'missing\n', new_string: 'x\n' }, agentContext(root)), /not found/);
  const result = await executeTool('edit_file', { path: 'f.txt', old_string: 'line 1\n', new_string: 'LINE ONE\n' }, agentContext(root));
  assert.equal(result.changed, true);
});

test('concurrent edits through a symlinked directory share the same canonical lock', async (t) => {
  const root = await fixture(t);
  const actual = path.join(root, 'actual');
  await mkdir(actual);
  await rename(path.join(root, 'f.txt'), path.join(actual, 'f.txt'));
  try {
    await symlink('actual', path.join(root, 'alias'), 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('directory symlinks are unavailable on this runner');
    throw error;
  }

  const results = await Promise.all([
    executeTool('edit_file', { path: 'actual/f.txt', old_string: 'line 2\\n', new_string: 'REAL PATH EDIT\\n' }, agentContext(root)),
    executeTool('edit_file', { path: 'alias/f.txt', old_string: 'line 17\\n', new_string: 'SYMLINK PATH EDIT\\n' }, agentContext(root))
  ]);
  assert.ok(results.every((result) => result.changed === true), JSON.stringify(results));
  const contents = await readFile(path.join(actual, 'f.txt'), 'utf8');
  assert.match(contents, /REAL PATH EDIT/);
  assert.match(contents, /SYMLINK PATH EDIT/, 'the symlink alias must not race the canonical path');
});
