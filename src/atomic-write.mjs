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
