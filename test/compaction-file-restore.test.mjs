import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createSession, closeSession, compactHistoryIfNeeded } from '../src/agent.mjs';
import { executeTool } from '../src/tools.mjs';
import { restoreFilesAfterCompaction } from '../src/file-state.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

test('restoreFilesAfterCompaction re-attaches recent small files and demotes the rest', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cfr-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_REQUIRE_READ_BEFORE_EDIT: '' };
  const context = { root, env, autoApprove: true, approval: async () => true, session: { config: {} } };
  await writeFile(path.join(root, 'old.txt'), 'old\n');
  await writeFile(path.join(root, 'big.txt'), 'b'.repeat(30000) + '\n');
  await writeFile(path.join(root, 'new.txt'), 'alpha\nbeta\n');
  for (const file of ['old.txt', 'big.txt', 'new.txt']) await executeTool('read_file', { path: file }, context);
  const restored = await restoreFilesAfterCompaction(context, { root, maxFiles: 1 });
  assert.deepEqual(restored.files, ['new.txt']);
  assert.match(restored.text, /<file path="new\.txt">\n1\talpha\n2\tbeta\n<\/file>/);
  // The re-attached file can still be overwritten; the others need a fresh read.
  await executeTool('write_file', { path: 'new.txt', content: 'gamma\n' }, context);
  await assert.rejects(executeTool('write_file', { path: 'old.txt', content: 'x' }, context), /summarized away by compaction/);
  await assert.rejects(executeTool('write_file', { path: 'big.txt', content: 'x' }, context), /summarized away by compaction/);
  // Exact edits still work, and a full re-read restores overwrite rights.
  await executeTool('edit_file', { path: 'old.txt', old_string: 'old', new_string: 'older' }, context);
  await executeTool('read_file', { path: 'big.txt' }, context);
  await executeTool('write_file', { path: 'big.txt', content: 'small\n' }, context);
});

test('a compacted session carries the most recently read files in its digest', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cfr-session-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'app.js'), 'export const answer = 42;\n');
  const { config } = await scriptedModel(t, [{ content: 'SUMMARY of earlier work' }]);
  const session = await createSession({ root, config, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  t.after(() => closeSession(session));
  await executeTool('read_file', { path: 'app.js' }, { root, session, env: process.env });
  for (let i = 0; i < 6; i++) session.messages.push({ role: 'user', content: 'ask ' + i }, { role: 'assistant', content: 'answer ' + i });
  const result = await compactHistoryIfNeeded(session, { force: true });
  assert.equal(result.compacted, true);
  const digest = session.messages[1].content;
  assert.match(digest, /SUMMARY of earlier work/);
  assert.match(digest, /re-attached after compaction[\s\S]*<file path="app\.js">\n1\texport const answer = 42;/);
});
