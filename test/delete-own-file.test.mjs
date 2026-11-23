import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readdir } from 'node:fs/promises';
import { executeTool } from '../src/tools.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-delete-own-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Seen live (gpt-oss-20b, oasis eval): the model wrote "report" as a file,
// then could not make report/ a folder or remove its own file.
test('under auto-approval a session may delete a file it created and nobody changed', async (t) => {
  const root = await workspace(t);
  const session = {};
  const context = { root, session, autoApprove: true };
  await executeTool('write_file', { path: 'report', content: '{}' }, context);
  const result = await executeTool('delete_file', { path: 'report' }, context);
  assert.notEqual(result.approved, false, JSON.stringify(result));
  assert.ok(!(await readdir(root)).includes('report'));
});

test('a file that existed before, or changed since the agent wrote it, still asks', async (t) => {
  const root = await workspace(t);
  await writeFile(path.join(root, 'user.txt'), 'mine\n');
  const session = {};
  const context = { root, session, autoApprove: true };
  assert.equal((await executeTool('delete_file', { path: 'user.txt' }, context)).approved, false);
  await executeTool('write_file', { path: 'made.txt', content: 'a' }, context);
  await writeFile(path.join(root, 'made.txt'), 'changed by someone else');
  assert.equal((await executeTool('delete_file', { path: 'made.txt' }, context)).approved, false);
  // Overwriting a pre-existing file does not make it the agent's own.
  await executeTool('read_file', { path: 'user.txt' }, context);
  await executeTool('write_file', { path: 'user.txt', content: 'agent text' }, context);
  assert.equal((await executeTool('delete_file', { path: 'user.txt' }, context)).approved, false);
  assert.deepEqual((await readdir(root)).sort(), ['made.txt', 'user.txt']);
});

test('without auto-approval the agent\'s own file still asks', async (t) => {
  const root = await workspace(t);
  const session = {};
  await executeTool('write_file', { path: 'x.txt', content: 'a' }, { root, session, autoApprove: true });
  assert.equal((await executeTool('delete_file', { path: 'x.txt' }, { root, session, autoApprove: false })).approved, false);
});
