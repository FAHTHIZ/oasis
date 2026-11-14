// Crash-safe file replacement for agent edits.
//
// A plain writeFile truncates the target first and then writes. If the process
// is killed, the machine loses power or the disk fills up in between, the
// user's file is left empty or half-written. Here the new content goes to a
// temporary sibling, is flushed to disk, and then renamed over the target in
// one step, so a reader sees either the old file or the new one.
//
// The existing file's permission bits are kept. Symlinks are resolved first so
// the link itself is not replaced by a regular file. Hard-linked files and
// filesystems that refuse the rename (some network and Windows shares, or a
// file held open on Windows) fall back to an in-place write, because replacing
// the inode there would silently break the link or fail.
import { open, rename, unlink, stat, lstat, realpath, writeFile, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { openSync, writeSync, fsyncSync, closeSync, renameSync, unlinkSync, chmodSync } from 'node:fs';

const FALLBACK_CODES = new Set(['EXDEV', 'EPERM', 'EACCES', 'EBUSY', 'ENOTSUP', 'EINVAL', 'EISDIR']);

export async function atomicWriteFile(file, data, options = {}) {
  const encoding = typeof options === 'string' ? options : options.encoding || 'utf8';
  const requestedMode = typeof options === 'object' ? options.mode : undefined;
  let target = file;
  let existing = null;
  try {
    const link = await lstat(file);
    if (link.isSymbolicLink()) target = await realpath(file);
    existing = link.isSymbolicLink() ? await stat(target) : link;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing && existing.nlink > 1) {
    await writeFile(target, data, { encoding });
    return { atomic: false, reason: 'hard link' };
  }
  const mode = existing ? existing.mode & 0o7777 : (requestedMode ?? 0o666);
  const temp = path.join(path.dirname(target), '.' + path.basename(target) + '.oasis-' + process.pid + '-' + randomBytes(6).toString('hex') + '.tmp');
  let handle;
  try {
    handle = await open(temp, 'wx', existing ? 0o600 : mode);
    await handle.writeFile(data, { encoding });
    await handle.sync();
    await handle.close();
    handle = null;
    if (existing) await chmod(temp, mode).catch(() => {});
    await rename(temp, target);
    return { atomic: true };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    if (FALLBACK_CODES.has(error.code)) {
      await writeFile(target, data, { encoding, ...(existing ? {} : { mode }) });
      return { atomic: false, reason: error.code };
    }
    throw error;
  }
}

// Windows refuses to rename over a file that an antivirus scanner, the search
// indexer or a sync client briefly holds open (EPERM/EBUSY/EACCES). Those locks
// clear within moments, so the rename is retried for about a second (the
// approach graceful-fs and VS Code use) instead of failing the save.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
async function renameWithRetry(from, to, { attempts = process.platform === 'win32' ? 8 : 1 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await rename(from, to); } catch (error) {
      if (attempt >= attempts || !RENAME_RETRY_CODES.has(error && error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(400, 15 * 2 ** attempt)));
    }
  }
}

// Replaces an OASIS-owned state file (sessions, indexes, settings it wrote)
// so that a crash, power loss or full disk leaves either the old file or the
// new one, never a truncated file or a stray temporary. Unlike
// atomicWriteFile it never falls back to an in-place write: for state files a
// failed save is better than a half-written one. The data is flushed before
// the rename and the directory entry after it (POSIX; best effort).
export async function replaceFileDurably(file, data, { mode = 0o600, encoding = 'utf8' } = {}) {
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '-' + randomBytes(6).toString('hex') + '.tmp');
  let handle;
  try {
    handle = await open(temp, 'wx', mode);
    await handle.writeFile(data, { encoding });
    await handle.sync();
    await handle.close();
    handle = null;
    await renameWithRetry(temp, file);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temp).catch(() => {});
    throw error;
  }
  try { await chmod(file, mode); } catch {}
  if (process.platform !== 'win32') {
    let dir;
    try { dir = await open(path.dirname(file), 'r'); await dir.sync(); } catch { /* some filesystems refuse directory fsync */ } finally { if (dir) await dir.close().catch(() => {}); }
  }
}

// Synchronous twin of replaceFileDurably for the few callers that cannot
// await (caches written during startup). Same guarantees; rename is not
// retried on Windows because the caller would block.
export function replaceFileDurablySync(file, data, { mode = 0o600, encoding = 'utf8' } = {}) {
  const temp = path.join(path.dirname(file), '.' + path.basename(file) + '.' + process.pid + '-' + randomBytes(6).toString('hex') + '.tmp');
  let fd = null;
  try {
    fd = openSync(temp, 'wx', mode);
    const buffer = Buffer.isBuffer(data) || data instanceof Uint8Array ? data : Buffer.from(String(data), encoding);
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(fd, buffer, offset, buffer.length - offset);
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(temp, file);
  } catch (error) {
    if (fd !== null) { try { closeSync(fd); } catch {} }
    try { unlinkSync(temp); } catch {}
    throw error;
  }
  try { chmodSync(file, mode); } catch {}
}
