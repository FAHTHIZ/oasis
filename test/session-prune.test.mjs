import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveSession, listSessions, staleSessions, pruneSessions } from '../src/sessions.mjs';

test('staleSessions/pruneSessions delete only chats older than the cutoff and honor keep', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-prune-'));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  try {
    const a = await saveSession({ root, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'a' }], config: { model: 'x' } }, { env });
    const b = await saveSession({ root, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'b' }], config: { model: 'x' } }, { env });
    assert.equal((await staleSessions(root, 30, { env })).length, 0);
    const future = Date.now() + 40 * 86400000;
    assert.equal((await staleSessions(root, 30, { env, now: future })).length, 2);
    const removed = await pruneSessions(root, 30, { env, now: future, keep: [a.id] });
    assert.deepEqual(removed, [b.id]);
    assert.deepEqual((await listSessions(root, { env })).map((s) => s.id), [a.id]);
    await assert.rejects(() => staleSessions(root, 0, { env }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

