// Two processes on the same saved session: the second save must not
// overwrite the first one's conversation; it is saved as a new session.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession } from '../src/agent.mjs';
import { saveSession, loadSession } from '../src/sessions.mjs';

const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'fixture', apiKey: '' };

test('a session saved elsewhere meanwhile is kept; this one is saved as a new session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg') };
  const first = await createSession({ root, config, env });
  first.messages.push({ role: 'user', content: 'start' }, { role: 'assistant', content: 'ok' });
  const { id } = await saveSession(first, { env });

  // Two terminals resume the same session.
  const a = await createSession({ root, config, env, restore: await loadSession(root, id, { env }) });
  const b = await createSession({ root, config, env, restore: await loadSession(root, id, { env }) });
  a.messages.push({ role: 'user', content: 'from A' }, { role: 'assistant', content: 'A done' });
  b.messages.push({ role: 'user', content: 'from B' }, { role: 'assistant', content: 'B done' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  const savedA = await saveSession(a, { env });
  assert.equal(savedA.id, id);
  assert.equal(savedA.forkedFrom, undefined);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const savedB = await saveSession(b, { env });
  assert.notEqual(savedB.id, id);
  assert.equal(savedB.forkedFrom, id);
  assert.equal(b.sessionId, savedB.id);
  assert.ok(b.hookMessages.some((note) => note.includes(savedB.id)));

  const onDiskA = await loadSession(root, id, { env });
  assert.ok(onDiskA.messages.some((m) => m.content === 'from A'));
  assert.ok(!onDiskA.messages.some((m) => m.content === 'from B'));
  const onDiskB = await loadSession(root, savedB.id, { env });
  assert.ok(onDiskB.messages.some((m) => m.content === 'from B'));

  // Later saves of either keep going to their own files.
  a.messages.push({ role: 'user', content: 'A again' }, { role: 'assistant', content: 'ok' });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await saveSession(a, { env })).id, id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await saveSession(b, { env })).id, savedB.id);
});

test('repeated saves from one process stay on the same session', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-concurrent-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg') };
  const session = await createSession({ root, config, env });
  session.messages.push({ role: 'user', content: 'x' });
  const { id } = await saveSession(session, { env });
  for (let index = 0; index < 3; index += 1) {
    session.messages.push({ role: 'assistant', content: 'r' + index }, { role: 'user', content: 'u' + index });
    assert.equal((await saveSession(session, { env })).id, id);
  }
});

test('archiving a session elsewhere survives the live session saving again', async (t) => {
  const { setSessionArchived, listSessions } = await import('../src/sessions.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-archive-live-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg') };
  const live = await createSession({ root, config, env });
  live.messages.push({ role: 'user', content: 'start' }, { role: 'assistant', content: 'ok' });
  const { id } = await saveSession(live, { env });
  await setSessionArchived(root, id, true, { env });
  live.messages.push({ role: 'user', content: 'more' }, { role: 'assistant', content: 'ok' });
  assert.equal((await saveSession(live, { env })).id, id);
  assert.equal((await loadSession(root, id, { env })).archived, true);
  assert.equal((await listSessions(root, { env })).find((item) => item.id === id).archived, true);

  // Unarchiving in the live session itself still wins.
  live.archived = false;
  await saveSession(live, { env });
  assert.equal((await loadSession(root, id, { env })).archived, false);

  // A resumed session behaves the same.
  const resumed = await createSession({ root, config, env, restore: await loadSession(root, id, { env }) });
  await setSessionArchived(root, id, true, { env });
  resumed.messages.push({ role: 'user', content: 'again' }, { role: 'assistant', content: 'ok' });
  await saveSession(resumed, { env });
  assert.equal((await loadSession(root, id, { env })).archived, true);
});
