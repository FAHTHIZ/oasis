import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { getSessionDirectory, loadSession, listSessions } from '../src/sessions.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-session-bounds-'));
  const root = path.join(base, 'workspace');
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'config') };
  await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, env };
}

function payload(root, id) {
  return {
    schemaVersion: 1,
    id,
    workspaceRoot: path.resolve(root),
    updatedAt: new Date().toISOString(),
    provider: { model: 'fixture' },
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }]
  };
}

test('loadSession rejects oversized files and session listings skip oversized entries', async (t) => {
  const { root, env } = await fixture(t);
  const id = '0123456789abcdef01234567';
  const directory = getSessionDirectory(root, env);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, id + '.json'), ' '.repeat(3 * 1024 * 1024 + 1));
  await assert.rejects(loadSession(root, id, { env }), /Stored session is too large/);
  assert.deepEqual(await listSessions(root, { env }), []);
});

test('loadSession refuses symlinked session files and listings omit them', { skip: process.platform === 'win32' }, async (t) => {
  const { root, env, base } = await fixture(t);
  const id = 'abcdef0123456789abcdef01';
  const directory = getSessionDirectory(root, env);
  await mkdir(directory, { recursive: true });
  const outside = path.join(base, 'outside.json');
  await writeFile(outside, JSON.stringify(payload(root, id)));
  await symlink(outside, path.join(directory, id + '.json'));
  await assert.rejects(loadSession(root, id, { env }), /regular, non-symlink/);
  assert.deepEqual(await listSessions(root, { env }), []);
});
