// Zip export and import for the browser app, on fflate (MIT, no dependencies):
// deflate-compressed export, stored/deflate/ZIP64 import.
import { zipSync, unzipSync } from 'fflate';

const IGNORED = /(^|\/)(__MACOSX|\.git|node_modules)\//;

/** files: [{ path, content: string|Uint8Array }] → Uint8Array zip */
export function createZip(files, now = new Date()) {
  const encoder = new TextEncoder();
  const tree = {};
  for (const file of files) {
    const data = typeof file.content === 'string' ? encoder.encode(file.content) : file.content;
    tree[file.path] = [data, { mtime: now }];
  }
  return zipSync(tree, { level: 6 });
}

/** Read a zip into [{ path, bytes }]. Strips a single shared top folder. */
export async function readZip(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let entries;
  try {
    entries = unzipSync(bytes, { filter: (file) => !file.name.endsWith('/') });
  } catch (error) {
    throw new Error('Not a zip file, or the zip is damaged: ' + (error?.message || error));
  }
  const files = Object.entries(entries).map(([path, data]) => ({ path, bytes: data }));
  const tops = new Set(files.map((file) => file.path.split('/')[0]));
  if (tops.size === 1 && files.every((file) => file.path.includes('/'))) {
    const prefix = [...tops][0] + '/';
    for (const file of files) file.path = file.path.slice(prefix.length);
  }
  return files.filter((file) => file.path && !IGNORED.test(file.path));
}
