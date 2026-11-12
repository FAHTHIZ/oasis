// Shared output path handling for generated media (images, speech): a readable
// default file name, workspace-scoped path resolution, and an atomic write.
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { atomicWriteFile } from './atomic-write.mjs';

function mediaSlug(text, fallback) {
  return String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || fallback;
}

// Writes bytes to args.path, or to <folder>/<slug>-<time>.<ext>. Returns the
// workspace-relative path with forward slashes.
export async function saveGeneratedMedia(bytes, { requestedPath, folder, label, fallback, extension, resolvePath, beforeWrite }) {
  const requested = requestedPath ? String(requestedPath) : path.posix.join(folder, mediaSlug(label, fallback) + '-' + Date.now().toString(36) + '.' + extension);
  const target = await resolvePath(requested);
  await mkdir(path.dirname(target.absolute), { recursive: true });
  if (beforeWrite) await beforeWrite(target);
  await atomicWriteFile(target.absolute, bytes, {});
  return target.relative.split(path.sep).join('/');
}
