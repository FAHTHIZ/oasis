import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, closeSession } from '../src/agent.mjs';

// --from-pr appends the PR description, file list and up to 40,000
// characters of diff; a 20,000-character cap dropped most of the diff.
test('a long appended system prompt is kept whole', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-append-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const diff = Array.from({ length: 1500 }, (_, i) => '+line ' + i + ' of the pull request diff').join('\n') + '\nDIFF-END';
  assert.ok(diff.length > 30000);
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: '' }, appendSystemPrompt: 'Diff (truncated):\n' + diff, permissionMode: 'bypassPermissions' });
  t.after(() => closeSession(session));
  const system = session.messages.find((message) => message.role === 'system');
  assert.match(String(system.content), /DIFF-END/);
});
