import { copyFile, mkdir, readFile, readdir, realpath, stat, lstat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { getConfigDirectory } from './config.mjs';

async function workspaceIdentity(root) {
  const realRoot = await realpath(root);
  return { realRoot, id: createHash('sha256').update(realRoot).digest('hex').slice(0, 16) };
}

function within(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

export async function snapshotFile(root, filePath, reason = 'overwrite') {
  const identity = await workspaceIdentity(root);
  const relativePath = path.relative(identity.realRoot, filePath);
  if (!relativePath || !within(identity.realRoot, filePath)) throw new Error('Refusing to back up a path outside the workspace.');
  const backupId = Date.now().toString(36) + '-' + randomUUID().slice(0, 8);
  const backupRoot = path.join(getConfigDirectory(), 'backups', identity.id, backupId);
  const target = path.join(backupRoot, relativePath);
  await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  await copyFile(filePath, target);
  const manifest = {
    id: backupId,
    workspaceRoot: identity.realRoot,
    relativePath,
    backupPath: relativePath.split(path.sep).join('/'),
    reason,
    createdAt: new Date().toISOString()
  };
  await writeFile(path.join(backupRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
  return manifest;
}

export async function listBackups(root) {
  const identity = await workspaceIdentity(root);
  const base = path.join(getConfigDirectory(), 'backups', identity.id);
  let dirs;
  try { dirs = await readdir(base, { withFileTypes: true }); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  const rows = [];
  for (const dir of dirs) {
    if (!dir.isDirectory() || !/^[a-z0-9-]+$/i.test(dir.name)) continue;
    try {
      const manifest = JSON.parse(await readFile(path.join(base, dir.name, 'manifest.json'), 'utf8'));
      if (manifest.id === dir.name && manifest.workspaceRoot === identity.realRoot) rows.push(manifest);
    } catch { /* Ignore incomplete or invalid backup metadata. */ }
  }
  return rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function restoreBackup(root, backupId) {
  if (!/^[a-z0-9-]{8,80}$/i.test(String(backupId))) throw new Error('Invalid backup ID.');
  const identity = await workspaceIdentity(root);
  const backupRoot = path.join(getConfigDirectory(), 'backups', identity.id, String(backupId));
  const manifest = JSON.parse(await readFile(path.join(backupRoot, 'manifest.json'), 'utf8'));
  if (manifest.id !== backupId || manifest.workspaceRoot !== identity.realRoot || typeof manifest.relativePath !== 'string') {
    throw new Error('That backup does not belong to this workspace.');
  }
  const relative = manifest.relativePath;
  if (path.isAbsolute(relative) || relative.split(path.sep).includes('..')) throw new Error('Invalid path in backup metadata.');
  const target = path.resolve(identity.realRoot, relative);
  if (!within(identity.realRoot, target) || target === identity.realRoot) throw new Error('Backup path escapes the workspace.');
  const source = path.resolve(backupRoot, relative);
  if (!within(backupRoot, source)) throw new Error('Backup file escapes the backup directory.');
  await stat(source);
  let cursor = path.dirname(target);
  while (true) {
    try {
      const resolved = await realpath(cursor);
      if (!within(identity.realRoot, resolved)) throw new Error('Restore destination resolves outside the workspace.');
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error('Could not resolve a safe restore destination.');
      cursor = parent;
    }
  }
  try {
    const targetInfo = await lstat(target);
    if (targetInfo.isSymbolicLink()) throw new Error('Restore destination is a symbolic link; refusing to write through it.');
    if (targetInfo.isDirectory()) throw new Error('Restore destination is a directory, not a regular file.');
    await snapshotFile(root, target, 'before-restore');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  await mkdir(path.dirname(target), { recursive: true });
  await copyFile(source, target);
  return { path: relative.split(path.sep).join('/'), restoredFrom: backupId };
}
