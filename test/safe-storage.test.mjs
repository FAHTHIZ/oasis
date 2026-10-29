import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { readBoundedRegularFile } from '../src/safe-storage.mjs';

test('bounded reader returns ordinary files and enforces the byte ceiling', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-bounded-file-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'data.json');
  await writeFile(file, '{"ok":true}');
  assert.equal(await readBoundedRegularFile(file, 32, { label: 'Fixture' }), '{"ok":true}');
  await writeFile(file, 'x'.repeat(100000));
  await assert.rejects(readBoundedRegularFile(file, 64, { label: 'Fixture', tooLargeMessage: 'Fixture exceeds 64 bytes.' }), /exceeds 64 bytes/);
});

test('bounded reader refuses symbolic links', { skip: process.platform === 'win32' }, async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-bounded-link-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'target.json');
  const link = path.join(dir, 'link.json');
  await writeFile(target, '{"secret":"not through this path"}');
  await symlink(target, link);
  await assert.rejects(readBoundedRegularFile(link, 1024, { label: 'Fixture' }), /regular, non-symlink/);
});
