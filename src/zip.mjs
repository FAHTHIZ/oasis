// ZIP reader for plugin archives (--plugin-url), on yauzl (MIT; the reader behind
// extract-zip, Electron and Puppeteer): ZIP64, CP437 and Info-ZIP Unicode names, and
// entry sizes checked against the central directory while inflating. On top of that,
// every entry's CRC-32 is verified, and paths that would escape the destination,
// unportable or colliding names, symlinks and absurdly large archives are rejected.
import { oasisVersion } from './version.mjs';
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { crc32 } from 'node:zlib';
import yauzl from 'yauzl';
import { isBlockedAddress, isLocalHostname, normalizeHostname, pinnedRequest, readBoundedBody, resolvePublicAddresses } from './safe-http.mjs';
import { isLoopbackUrl } from './config.mjs';

const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_ENTRIES = 20000;

// Portable-path policy: names that are unsafe or ambiguous on Windows or POSIX.
function checkEntryName(name, seenPaths) {
  const parts = name.split('/');
  if (parts.some((part) => part === '..')) throw new Error('Zip entry escapes the destination: ' + name);
  if (!name || name.includes(String.fromCharCode(0)) ||
      parts.some((part, i) => part === '.' || (!part && i !== parts.length - 1) ||
        /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
    throw new Error('Zip entry has an unsafe or ambiguous path: ' + name);
  }
  // Reject duplicate/case-colliding paths so extraction is deterministic on
  // both case-sensitive and case-insensitive filesystems.
  const pathKey = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
  if (seenPaths.has(pathKey)) throw new Error('Zip archive contains duplicate or case-colliding paths: ' + name);
  seenPaths.add(pathKey);
}

const openBuffer = (data) => new Promise((resolve, reject) => {
  yauzl.fromBuffer(data, { lazyEntries: true, validateEntrySizes: true, strictFileNames: false }, (error, zip) => {
    if (error) reject(new Error('Not a zip archive (' + error.message + ').'));
    else resolve(zip);
  });
});

const readEntry = (zip, entry) => new Promise((resolve, reject) => {
  zip.openReadStream(entry, (error, stream) => {
    if (error) return reject(error);
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
});

/** Reads every file and directory entry of a ZIP buffer: [{ name, directory } | { name, content, executable }]. */
export async function readZipEntries(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const zip = await openBuffer(data);
  if (zip.entryCount > MAX_ENTRIES) { zip.close(); throw new Error('Zip archive has too many entries.'); }
  const entries = [];
  const seenPaths = new Set();
  let total = 0;
  try {
    await new Promise((resolve, reject) => {
      const fail = (error) => reject(/^Zip /.test(error.message) ? error
        : /^(absolute path|invalid relative path): /.test(error.message) ? new Error('Zip entry escapes the destination (' + error.message + ').')
          : new Error('Corrupt zip archive: ' + error.message));
      zip.on('error', fail);
      zip.on('end', resolve);
      zip.on('entry', (entry) => (async () => {
        const name = entry.fileName;
        checkEntryName(name, seenPaths);
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        if (mode === 0o120000) return; // symlink: skipped
        if (name.endsWith('/')) { entries.push({ name, directory: true }); return; }
        if (entry.isEncrypted()) throw new Error('Zip entry is encrypted: ' + name);
        if (entry.compressionMethod !== 0 && entry.compressionMethod !== 8) {
          throw new Error('Unsupported zip compression method ' + entry.compressionMethod + ' for ' + name + '.');
        }
        total += entry.uncompressedSize;
        if (total > MAX_TOTAL) throw new Error('Zip archive is too large when extracted.');
        const content = await readEntry(zip, entry);
        if (crc32(content) !== entry.crc32) throw new Error('Zip entry failed its CRC-32 check: ' + name + '.');
        entries.push({ name, content, executable: Boolean((entry.externalFileAttributes >>> 16) & 0o111) });
      })().then(() => zip.readEntry(), fail));
      zip.readEntry();
    });
  } finally {
    zip.close();
  }
  return entries;
}

export async function extractZip(buffer, destination) {
  const root = path.resolve(destination);
  await mkdir(root, { recursive: true });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('ZIP destination must be a real directory, not a symbolic link.');
  const realRoot = await realpath(root);
  const files = [];
  const ensureSafeParents = async (target, includeTarget = false) => {
    const stop = includeTarget ? target : path.dirname(target);
    let cursor = realRoot;
    const relative = path.relative(realRoot, stop);
    if (relative.startsWith('..' + path.sep) || relative === '..' || path.isAbsolute(relative)) {
      throw new Error('Zip entry escapes the destination: ' + target);
    }
    for (const part of relative.split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, part);
      try {
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) throw new Error('ZIP extraction refuses to write through symbolic links: ' + cursor);
        if (!info.isDirectory() && cursor !== target) throw new Error('ZIP path component is not a directory: ' + cursor);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
  };
  for (const entry of await readZipEntries(buffer)) {
    const target = path.resolve(realRoot, entry.name);
    if (target !== realRoot && !target.startsWith(realRoot + path.sep)) throw new Error('Zip entry escapes the destination: ' + entry.name);
    await ensureSafeParents(target);
    if (entry.directory) {
      await ensureSafeParents(target, true);
      await mkdir(target, { recursive: true });
      await ensureSafeParents(target, true);
      continue;
    }
    await mkdir(path.dirname(target), { recursive: true });
    await ensureSafeParents(target);
    await writeFile(target, entry.content, { mode: entry.executable ? 0o755 : 0o644, flag: 'wx' });
    files.push(path.relative(realRoot, target));
  }
  return files;
}

async function validateArchiveTarget(rawUrl, lookupImpl = lookup) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('--plugin-url needs a valid public HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--plugin-url accepts HTTP(S) URLs only (http/https); local file URLs are blocked.');
  if (parsed.username || parsed.password) throw new Error('--plugin-url must not contain embedded credentials.');
  const host = normalizeHostname(parsed);
  const local = isLoopbackUrl(parsed.toString());
  if (parsed.protocol === 'http:' && !local) throw new Error('--plugin-url requires HTTPS for non-local downloads.');
  if (local) {
    const addresses = host === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : null;
    return { url: parsed, addresses };
  }
  if (isLocalHostname(host)) throw new Error('--plugin-url cannot target a local or internal hostname.');
  // Classify IP literals before the single-label hostname rule so IPv6 literals
  // are checked by the shared SSRF policy rather than mistaken for hostnames.
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error('--plugin-url cannot target private or special-purpose IP addresses.');
    return { url: parsed, addresses: null };
  }
  if (!host.includes('.')) throw new Error('--plugin-url cannot target a single-label hostname.');
  const resolved = await resolvePublicAddresses(host, { lookupImpl });
  if (resolved.reason === 'unresolved') throw new Error('--plugin-url hostname could not be safely resolved.');
  if (resolved.reason === 'private') throw new Error('--plugin-url hostname resolves to a private or special-purpose address.');
  return { url: parsed, addresses: resolved.addresses };
}

function tooLargeError(maxBytes) {
  return new Error('--plugin-url archive is larger than ' + Math.round(maxBytes / 1048576) + ' MB.');
}

async function fetchPinnedArchiveBytes(parsed, addresses, maxBytes, signal) {
  const response = await pinnedRequest(parsed, {
    addresses,
    maxBytes,
    signal,
    timeoutMs: 60000,
    timeoutMessage: '--plugin-url download timed out.',
    headers: { 'user-agent': 'OasisOSS/' + oasisVersion() + ' (+https://github.com/FAHTHIZ/oasis)', accept: 'application/zip, application/octet-stream, */*;q=0.1' }
  });
  if (response.status >= 300 && response.status < 400) return { status: response.status, location: response.headers.get('location') };
  if (response.status < 200 || response.status >= 300) return { status: response.status, location: null };
  if (response.tooLarge) throw tooLargeError(maxBytes);
  return { status: response.status, body: response.body };
}

// --plugin-url URL: download an HTTP(S) plugin .zip for this session only and return the plugin root
// (the directory with .claude-plugin/plugin.json, or the single top-level folder).
export async function fetchPluginArchive(url, { fetchImpl = globalThis.fetch, tmpRoot = null, maxBytes = 100 * 1024 * 1024, lookupImpl = lookup } = {}) {
  const { mkdtemp, readdir, stat } = await import('node:fs/promises');
  const os = await import('node:os');
  const limit = Number.isFinite(maxBytes) && maxBytes > 0 ? Math.min(maxBytes, 100 * 1024 * 1024) : 100 * 1024 * 1024;
  let currentUrl = String(url || '');
  let firstUrl;
  try { firstUrl = new URL(currentUrl); } catch { /* validateArchiveTarget returns the user-facing error */ }
  const allowLoopbackHttp = Boolean(firstUrl && isLoopbackUrl(firstUrl.toString()));
  const visited = new Set();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let buffer;
  let finalHref = currentUrl;
  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
      const { url: parsed, addresses } = await validateArchiveTarget(currentUrl, lookupImpl);
      if (!allowLoopbackHttp && isLoopbackUrl(parsed.toString())) {
        throw new Error('--plugin-url redirects from a public URL to loopback are blocked.');
      }
      if (visited.has(parsed.href)) throw new Error('--plugin-url redirect loop detected.');
      visited.add(parsed.href);
      finalHref = parsed.href;
      let result;
      if (fetchImpl === globalThis.fetch) {
        result = await fetchPinnedArchiveBytes(parsed, addresses, limit, controller.signal);
      } else {
        const response = await fetchImpl(parsed.href, { redirect: 'manual', signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          result = { status: response.status, location: response.headers.get('location') || null };
          await response.body?.cancel().catch(() => {});
        } else {
          if (!response.ok) throw new Error('--plugin-url download failed: HTTP ' + response.status + ' for ' + parsed.href);
          const body = await readBoundedBody(response, limit);
          if (body === null) throw tooLargeError(limit);
          result = { status: response.status, body };
        }
      }
      if ([301, 302, 303, 307, 308].includes(result.status)) {
        if (!result.location) throw new Error('--plugin-url redirect response had no Location header.');
        if (redirectCount === 5) throw new Error('--plugin-url exceeded the five-redirect limit.');
        const nextUrl = new URL(result.location, parsed);
        if (!allowLoopbackHttp && isLoopbackUrl(nextUrl.toString())) {
          throw new Error('--plugin-url redirects from a public URL to loopback are blocked.');
        }
        currentUrl = nextUrl.toString();
        continue;
      }
      if (result.status < 200 || result.status >= 300) throw new Error('--plugin-url download failed: HTTP ' + result.status + ' for ' + parsed.href);
      buffer = result.body;
      break;
    }
  } finally {
    clearTimeout(timer);
  }
  if (!buffer) throw new Error('--plugin-url download did not produce an archive body.');

  const dir = await mkdtemp(path.join(tmpRoot || os.tmpdir(), 'oasis-plugin-url-'));
  try {
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
    throw new Error('--plugin-url archive has no plugin (expected .claude-plugin/plugin.json): ' + finalHref);
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
