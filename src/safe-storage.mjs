import { constants as fsConstants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';

// Bound allocations and reject ordinary-file/symlink swaps where the platform
// provides O_NOFOLLOW. Reads are tied to a descriptor, not an untrusted file size.
export async function readBoundedRegularFile(filePath, maxBytes, options = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError('maxBytes must be a non-negative safe integer.');
  const label = options.label || 'File';
  const tooLargeMessage = options.tooLargeMessage || (label + ' exceeds its size limit.');
  const before = await lstat(filePath);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(label + ' must be a regular, non-symlink file.');
  if (before.size > maxBytes) throw new Error(tooLargeMessage);
  const flags = fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW || 0));
  const handle = await open(filePath, flags);
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(label + ' must be a regular file.');
    if (info.size > maxBytes) throw new Error(tooLargeMessage);
    const chunkBuffer = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1));
    const chunks = [];
    let bytesRead = 0;
    while (bytesRead <= maxBytes) {
      const allowed = Math.min(chunkBuffer.length, maxBytes + 1 - bytesRead);
      const result = await handle.read(chunkBuffer, 0, allowed, bytesRead);
      if (!result.bytesRead) break;
      chunks.push(Buffer.from(chunkBuffer.subarray(0, result.bytesRead)));
      bytesRead += result.bytesRead;
    }
    if (bytesRead > maxBytes) throw new Error(tooLargeMessage);
    return Buffer.concat(chunks, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}
