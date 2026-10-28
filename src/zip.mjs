// Minimal, dependency-free ZIP reader for plugin archives (--plugin-url). Supports stored and
// deflated entries (what `zip`, GitHub archive downloads and most tools produce). Paths that
// would escape the destination, symlinks and absurdly large archives are rejected.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';

const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_ENTRIES = 20000;

export function readZipEntries(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (data.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip archive (no end-of-central-directory record).');
  const count = data.readUInt16LE(eocd + 10);
  let offset = data.readUInt32LE(eocd + 16);
  if (count > MAX_ENTRIES) throw new Error('Zip archive has too many entries.');
  const entries = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (data.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
    const method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const externalAttrs = data.readUInt32LE(offset + 38);
    const localOffset = data.readUInt32LE(offset + 42);
    const name = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    offset += 46 + nameLength + extraLength + commentLength;
    const mode = (externalAttrs >>> 16) & 0o170000;
    if (mode === 0o120000) continue; // symlink: skipped
    if (name.endsWith('/')) { entries.push({ name, directory: true }); continue; }
    total += size;
    if (total > MAX_TOTAL) throw new Error('Zip archive is too large when extracted.');
    if (data.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('Corrupt zip local header for ' + name + '.');
    const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
    const raw = data.subarray(start, start + compressed);
    let content;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) + 1024 });
    else throw new Error('Unsupported zip compression method ' + method + ' for ' + name + '.');
    entries.push({ name, content, executable: Boolean((externalAttrs >>> 16) & 0o111) });
  }
  return entries;
}

export async function extractZip(buffer, destination) {
  const root = path.resolve(destination);
  await mkdir(root, { recursive: true });
  const files = [];
  for (const entry of readZipEntries(buffer)) {
    const target = path.resolve(root, entry.name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error('Zip entry escapes the destination: ' + entry.name);
    if (entry.directory) { await mkdir(target, { recursive: true }); continue; }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, entry.content, { mode: entry.executable ? 0o755 : 0o644 });
    files.push(path.relative(root, target));
  }
  return files;
}

// --plugin-url URL: download a plugin .zip for this session only and return the plugin root
// (the directory with .claude-plugin/plugin.json, or the single top-level folder).
export async function fetchPluginArchive(url, { fetchImpl = globalThis.fetch, tmpRoot = null, maxBytes = 100 * 1024 * 1024 } = {}) {
  const { mkdtemp, readdir, stat } = await import('node:fs/promises');
  const os = await import('node:os');
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error('--plugin-url needs an http(s) URL: ' + url); }
  if (!['https:', 'http:', 'file:'].includes(parsed.protocol)) throw new Error('--plugin-url needs an http(s) URL: ' + url);
  let buffer;
  if (parsed.protocol === 'file:') buffer = await (await import('node:fs/promises')).readFile(parsed);
  else {
    const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) });
    if (!response.ok) throw new Error('--plugin-url download failed: HTTP ' + response.status + ' for ' + url);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > maxBytes) throw new Error('--plugin-url archive is larger than ' + Math.round(maxBytes / 1048576) + ' MB.');
    buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > maxBytes) throw new Error('--plugin-url archive is larger than ' + Math.round(maxBytes / 1048576) + ' MB.');
  }
  const dir = await mkdtemp(path.join(tmpRoot || os.tmpdir(), 'oasis-plugin-url-'));
  await extractZip(buffer, dir);
  const isPlugin = async (candidate) => {
    for (const marker of [path.join('.claude-plugin', 'plugin.json'), 'plugin.json', 'skills', 'commands', 'agents']) {
      try { await stat(path.join(candidate, marker)); return true; } catch {}
    }
    return false;
  };
  if (await isPlugin(dir)) return dir;
  const top = (await readdir(dir, { withFileTypes: true })).filter((entry) => !entry.name.startsWith('__MACOSX'));
  if (top.length === 1 && top[0].isDirectory() && await isPlugin(path.join(dir, top[0].name))) return path.join(dir, top[0].name);
  throw new Error('--plugin-url archive has no plugin (expected .claude-plugin/plugin.json): ' + url);
}
