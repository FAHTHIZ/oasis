// A damaged session file must be visible and removable, not silently skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, access } from 'node:fs/promises';
import { createSession } from '../src/agent.mjs';
import { saveSession, listSessions, unreadableSessions, deleteSession } from '../src/sessions.mjs';

const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: '' };

test('damaged session files are listed as unreadable and can be deleted', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-unreadable-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg') };
  const good = await createSession({ root, config, env });
  good.messages.push({ role: 'user', content: 'keep me' }, { role: 'assistant', content: 'ok' });
  const kept = await saveSession(good, { env });
  const bad = await createSession({ root, config, env });
  bad.messages.push({ role: 'user', content: 'damaged' }, { role: 'assistant', content: 'ok' });
  const damaged = await saveSession(bad, { env });
  await writeFile(damaged.path, '{"schemaVersion":1,"id":"' + damaged.id + '","messages":[{"role":');

  assert.deepEqual((await listSessions(root, { env })).map((item) => item.id), [kept.id]);
  const unreadable = await unreadableSessions(root, { env });
  assert.deepEqual(unreadable.map((item) => item.id), [damaged.id]);
  assert.match(unreadable[0].reason, /not valid JSON/);
  assert.ok(unreadable[0].modifiedAt);

  await deleteSession(root, damaged.id, { env });
  await assert.rejects(access(damaged.path));
  assert.deepEqual(await unreadableSessions(root, { env }), []);
  // A missing session is still an error, and readable ones still delete normally.
  await assert.rejects(deleteSession(root, damaged.id, { env }));
  await deleteSession(root, kept.id, { env });
  assert.deepEqual(await listSessions(root, { env }), []);
});
