import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile, utimes } from 'node:fs/promises';
import { executeTool } from '../src/tools.mjs';

async function setup(t, config = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-fs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.txt'), 'one\ntwo\n');
  const env = { ...process.env, OASIS_REQUIRE_READ_BEFORE_EDIT: '' };
  const context = { root, env, autoApprove: true, approval: async () => true, session: { config } };
  return { root, context };
}

test('overwriting an existing file requires reading it first; new files do not', async (t) => {
  const { root, context } = await setup(t);
  await assert.rejects(executeTool('write_file', { path: 'a.txt', content: 'x' }, context), /has not been read yet: a\.txt/);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\ntwo\n');
  await executeTool('write_file', { path: 'new.txt', content: 'fresh' }, context);
  await executeTool('write_file', { path: 'new.txt', content: 'fresh again' }, context);
  await executeTool('read_file', { path: 'a.txt' }, context);
  await executeTool('write_file', { path: 'a.txt', content: 'replaced' }, context);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'replaced');
});

test('edits are refused when the file changed on disk after it was read', async (t) => {
  const { root, context } = await setup(t);
  await executeTool('read_file', { path: 'a.txt' }, context);
  await executeTool('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'uno' }, context);
  await executeTool('multi_edit', { path: 'a.txt', edits: [{ old_string: 'two', new_string: 'dos' }] }, context);
  // The user edits the file in their editor.
  await writeFile(path.join(root, 'a.txt'), 'uno\ndos\nuser line\n');
  await utimes(path.join(root, 'a.txt'), new Date(), new Date(Date.now() + 5000));
  await assert.rejects(executeTool('edit_file', { path: 'a.txt', old_string: 'uno', new_string: 'ein' }, context), /modified since it was last read/);
  await assert.rejects(executeTool('write_file', { path: 'a.txt', content: 'clobber' }, context), /modified since it was last read/);
  assert.match(await readFile(path.join(root, 'a.txt'), 'utf8'), /user line/);
  await executeTool('read_file', { path: 'a.txt', offset: 1, limit: 1 }, context);
  await executeTool('edit_file', { path: 'a.txt', old_string: 'uno', new_string: 'ein' }, context);
});

test('a touched-but-identical file is not treated as stale', async (t) => {
  const { root, context } = await setup(t);
  await executeTool('read_file', { path: 'a.txt' }, context);
  await utimes(path.join(root, 'a.txt'), new Date(), new Date(Date.now() + 5000));
  await executeTool('write_file', { path: 'a.txt', content: 'ok' }, context);
});

test('strict mode requires a read before any edit, matching Claude Code exactly', async (t) => {
  const { context } = await setup(t, { requireReadBeforeEdit: 'strict' });
  await assert.rejects(executeTool('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'uno' }, context), /has not been read yet/);
  const relaxed = await setup(t);
  await executeTool('edit_file', { path: 'a.txt', old_string: 'one', new_string: 'uno' }, relaxed.context);
});

test('the guard can be disabled and is inactive without a session', async (t) => {
  const { context } = await setup(t);
  await executeTool('write_file', { path: 'a.txt', content: 'x' }, { ...context, env: { ...context.env, OASIS_REQUIRE_READ_BEFORE_EDIT: '0' } });
  await executeTool('write_file', { path: 'a.txt', content: 'y' }, { ...context, session: undefined });
});
