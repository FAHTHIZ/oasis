import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, readFile, readdir, rm, stat } from 'node:fs/promises';
import { beginCheckpoint, captureBeforeChange, saveCheckpoints, loadCheckpoints, rewind } from '../src/checkpoints.mjs';

test('a checkpoint blob cut short by a crash is rewritten on the next save', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-ckpt-blob-'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-ckpt-dir-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(dir, { recursive: true, force: true })]));
  const original = 'const value = 1;\n'.repeat(500);
  await writeFile(path.join(root, 'a.js'), original);
  const session = { root, messages: [{ role: 'system', content: 's' }] };
  const user = { role: 'user', content: 'change it' };
  session.messages.push(user);
  beginCheckpoint(session, user, 'change it');
  await captureBeforeChange(session, root, 'edit_file', { path: 'a.js' });
  await writeFile(path.join(root, 'a.js'), 'changed\n');
  assert.equal((await saveCheckpoints(session, dir)).saved, true);

  // Simulate a crash that left the blob half-written.
  const [blob] = await readdir(path.join(dir, 'blobs'));
  await writeFile(path.join(dir, 'blobs', blob), original.slice(0, 100));
  await saveCheckpoints(session, dir);
  assert.equal((await stat(path.join(dir, 'blobs', blob))).size, Buffer.byteLength(original));

  const restored = { root, messages: session.messages, checkpoints: await loadCheckpoints(dir) };
  const result = await rewind(restored, 1, 'code');
  assert.deepEqual(result.restored, ['a.js']);
  assert.equal(await readFile(path.join(root, 'a.js'), 'utf8'), original);
  // No temporary files are left next to the blobs or the index.
  assert.deepEqual((await readdir(dir)).filter((name) => name.endsWith('.tmp')), []);
  assert.deepEqual((await readdir(path.join(dir, 'blobs'))).filter((name) => name.endsWith('.tmp')), []);
});
