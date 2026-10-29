import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises';
import { snapshotFile, listBackups, restoreBackup } from '../src/backups.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-backup-bounds-'));
  const root = path.join(base, 'workspace');
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'config') };
  await mkdir(root);
  await writeFile(path.join(root, 'source.txt'), 'original');
  t.after(() => rm(base, { recursive: true, force: true }));
  const backup = await snapshotFile(root, path.join(root, 'source.txt'), 'test', { env });
  const realRoot = await realpath(root);
  const workspaceId = createHash('sha256').update(realRoot).digest('hex').slice(0, 16);
  const manifestPath = path.join(env.OASIS_CONFIG_DIR, 'backups', workspaceId, backup.id, 'manifest.json');
  return { root, env, backup, manifestPath };
}

test('backup manifest reads have a strict size ceiling', async (t) => {
  const { root, env, backup, manifestPath } = await fixture(t);
  await writeFile(manifestPath, 'x'.repeat(70 * 1024));
  assert.deepEqual(await listBackups(root, { env }), []);
  await assert.rejects(restoreBackup(root, backup.id, { env }), /Backup manifest exceeds the 64 KiB limit/);
});

test('restore rejects traversal and Windows absolute backup paths', async (t) => {
  const { root, env, backup, manifestPath } = await fixture(t);
  const original = JSON.parse(await readFile(manifestPath, 'utf8'));
  const slash = String.fromCharCode(92);
  const unsafePaths = ['../outside.txt', '..' + slash + 'outside.txt', 'C:' + slash + 'Windows' + slash + 'win.ini', slash + slash + 'server' + slash + 'share' + slash + 'file.txt', '/etc/passwd'];
  for (const unsafe of unsafePaths) {
    await writeFile(manifestPath, JSON.stringify({ ...original, relativePath: unsafe }));
    await assert.rejects(restoreBackup(root, backup.id, { env }), /Invalid path in backup metadata/, 'reject ' + unsafe);
  }
});
