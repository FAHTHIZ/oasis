// Minimal, dependency-free ZIP reader for plugin archives (--plugin-url). Supports stored and
// deflated entries (what `zip`, GitHub archive downloads and most tools produce). Paths that
// would escape the destination, symlinks and absurdly large archives are rejected.
import { lstat, mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isNonPublicIpAddress } from './network-safety.mjs';
import { isLoopbackUrl } from './config.mjs';
import { inflateRawSync } from 'node:zlib';

const MAX_TOTAL = 200 * 1024 * 1024;
const MAX_ENTRIES = 20000;

export function readZipEntries(buffer) {
  const data = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  if (data.length < 22) throw new Error('Not a zip archive (truncated end-of-central-directory record).');
  let eocd = -1;
  for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 65535); i--) {
    if (i + 22 <= data.length && data.readUInt32LE(i) === 0x06054b50) {
      const commentLength = data.readUInt16LE(i + 20);
      if (i + 22 + commentLength === data.length) { eocd = i; break; }
    }
  }
  if (eocd < 0) throw new Error('Not a zip archive (no valid end-of-central-directory record).');
  const diskNumber = data.readUInt16LE(eocd + 4);
  const centralDisk = data.readUInt16LE(eocd + 6);
  const diskCount = data.readUInt16LE(eocd + 8);
  const count = data.readUInt16LE(eocd + 10);
  const centralSize = data.readUInt32LE(eocd + 12);
  let offset = data.readUInt32LE(eocd + 16);
  if (diskNumber !== 0 || centralDisk !== 0 || diskCount !== count || count === 0xffff ||
      centralSize === 0xffffffff || offset === 0xffffffff) {
    throw new Error('Multi-disk and ZIP64 archives are not supported.');
  }
  if (count > MAX_ENTRIES) throw new Error('Zip archive has too many entries.');
  const centralStart = offset;
  const centralEnd = offset + centralSize;
  if (!Number.isSafeInteger(centralEnd) || offset < 0 || centralEnd > eocd) {
    throw new Error('Corrupt zip central-directory bounds.');
  }
  const entries = [];
  const seenPaths = new Set();
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (offset < 0 || offset + 46 > centralEnd || data.readUInt32LE(offset) !== 0x02014b50) throw new Error('Corrupt zip central directory.');
    const method = data.readUInt16LE(offset + 10);
    const compressed = data.readUInt32LE(offset + 20);
    const size = data.readUInt32LE(offset + 24);
    const nameLength = data.readUInt16LE(offset + 28);
    const extraLength = data.readUInt16LE(offset + 30);
    const commentLength = data.readUInt16LE(offset + 32);
    const externalAttrs = data.readUInt32LE(offset + 38);
    const localOffset = data.readUInt32LE(offset + 42);
    const recordEnd = offset + 46 + nameLength + extraLength + commentLength;
    if (recordEnd > centralEnd) throw new Error('Truncated zip central-directory entry.');
    const rawName = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    // ZIP paths must be portable: a backslash is a separator on Windows but a
    // literal character on POSIX. Normalize before checking containment.
    const name = rawName.replace(/\\/g, '/');
    const parts = name.split('/');
    if (parts.some((part) => part === '..')) throw new Error('Zip entry escapes the destination: ' + rawName);
    if (!name || name.includes(String.fromCharCode(0)) || name.startsWith('/') || /^[a-z]:/i.test(name) ||
        parts.some((part, i) => part === '.' || (!part && i !== parts.length - 1) ||
          /[<>:"|?*\x00-\x1f]/.test(part) || /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(part))) {
      throw new Error('Zip entry has an unsafe or ambiguous path: ' + rawName);
    }
    // Reject duplicate/case-colliding paths so extraction is deterministic on
    // both case-sensitive and case-insensitive filesystems.
    const pathKey = name.replace(/\/$/, '').normalize('NFC').toLowerCase();
    if (seenPaths.has(pathKey)) throw new Error('Zip archive contains duplicate or case-colliding paths: ' + rawName);
    seenPaths.add(pathKey);
    offset += 46 + nameLength + extraLength + commentLength;
    const mode = (externalAttrs >>> 16) & 0o170000;
    if (mode === 0o120000) continue; // symlink: skipped
    if (name.endsWith('/')) { entries.push({ name, directory: true }); continue; }
    total += size;
    if (total > MAX_TOTAL) throw new Error('Zip archive is too large when extracted.');
    if (localOffset < 0 || localOffset + 30 > centralStart || data.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error('Corrupt zip local header for ' + name + '.');
    }
    const localMethod = data.readUInt16LE(localOffset + 8);
    const localNameLength = data.readUInt16LE(localOffset + 26);
    const localExtraLength = data.readUInt16LE(localOffset + 28);
    const localNameEnd = localOffset + 30 + localNameLength;
    const start = localNameEnd + localExtraLength;
    if (localMethod !== method || localNameEnd > centralStart || start > centralStart ||
        data.subarray(localOffset + 30, localNameEnd).toString('utf8') !== rawName ||
        compressed > centralStart - start) {
      throw new Error('Corrupt zip compressed data or inconsistent local header for ' + name + '.');
    }
    const raw = data.subarray(start, start + compressed);
    let content;
    if (method === 0) content = Buffer.from(raw);
    else if (method === 8) content = inflateRawSync(raw, { maxOutputLength: Math.max(size, 1) });
    else throw new Error('Unsupported zip compression method ' + method + ' for ' + name + '.');
    if (content.length !== size) throw new Error('Zip entry size does not match its declared size: ' + name + '.');
    entries.push({ name, content, executable: Boolean((externalAttrs >>> 16) & 0o111) });
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
  for (const entry of readZipEntries(buffer)) {
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

// --plugin-url URL: download a plugin .zip for this session only and return the plugin root
// (the directory with .claude-plugin/plugin.json, or the single top-level folder).
function blockedAddress(address) {
  const version = isIP(String(address || '').replace(/^\[|\]$/g, ''));
  return version !== 4 && version !== 6 || isNonPublicIpAddress(address);
}

async function validateArchiveTarget(rawUrl, lookupImpl = lookup) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('--plugin-url needs a valid public HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--plugin-url accepts HTTP(S) URLs only (http/https); local file URLs are blocked.');
  if (parsed.username || parsed.password) throw new Error('--plugin-url must not contain embedded credentials.');
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const local = isLoopbackUrl(parsed.toString());
  if (parsed.protocol === 'http:' && !local) throw new Error('--plugin-url requires HTTPS for non-local downloads.');
  if (local) {
    const addresses = host === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : null;
    return { url: parsed, addresses };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.home.arpa') || host === 'metadata.google.internal') {
    throw new Error('--plugin-url cannot target a local or internal hostname.');
  }
  // Classify IP literals before the single-label hostname rule so IPv6 literals
  // are checked by the shared SSRF policy rather than mistaken for hostnames.
  if (isIP(host)) {
    if (blockedAddress(host)) throw new Error('--plugin-url cannot target private or special-purpose IP addresses.');
    return { url: parsed, addresses: null };
  }
  if (!host.includes('.')) throw new Error('--plugin-url cannot target a single-label hostname.');
  let records;
  try { records = await lookupImpl(host, { all: true, verbatim: true }); }
  catch { throw new Error('--plugin-url hostname could not be safely resolved.'); }
  if (!records.length || records.some((record) => blockedAddress(record.address))) {
    throw new Error('--plugin-url hostname resolves to a private or special-purpose address.');
  }
  return { url: parsed, addresses: records.map((record) => ({ address: record.address, family: record.family || isIP(record.address) })) };
}

async function boundedResponseBytes(response, maxBytes) {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new Error('--plugin-url archive is larger than ' + Math.round(maxBytes / 1048576) + ' MB.');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('--plugin-url archive is larger than ' + Math.round(maxBytes / 1048576) + ' MB.');
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, total);
}

async function fetchPinnedArchiveBytes(parsed, addresses, maxBytes, signal) {
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  const transport = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let total = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const options = {
      protocol: parsed.protocol,
      hostname,
      port: parsed.port || undefined,
      method: 'GET',
      path: parsed.pathname + parsed.search,
      headers: { 'user-agent': 'OasisOSS/0.3 (+https://github.com/FAHTHIZ/oasis)', accept: 'application/zip, application/octet-stream, */*;q=0.1' },
      signal
    };
    if (addresses && addresses.length && !isIP(hostname)) {
      options.lookup = (_host, lookupOptions, callback) => {
        if (typeof lookupOptions === 'function') { callback = lookupOptions; lookupOptions = {}; }
        if (lookupOptions && lookupOptions.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      };
    }
    let request;
    try {
      request = transport(parsed, options, (response) => {
        response.on('error', (error) => finish(error));
        if (response.statusCode >= 300 && response.statusCode < 400) {
          finish(null, { status: response.statusCode, location: response.headers.location || null });
          response.destroy();
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(null, { status: response.statusCode, location: null });
          response.destroy();
          return;
        }
        const declaredLength = Number(response.headers['content-length'] || 0);
        if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
          finish(new Error('--plugin-url archive is larger than ' + Math.round(maxBytes / 1048576) + ' MB.'));
          response.destroy();
          return;
        }
        response.on('data', (chunk) => {
          if (settled) return;
          total += chunk.length;
          if (total > maxBytes) {
            finish(new Error('--plugin-url archive is larger than ' + Math.round(maxBytes / 1048576) + ' MB.'));
            response.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => {
          if (!settled) finish(null, { status: response.statusCode, body: Buffer.concat(chunks, total) });
        });
      });
    } catch (error) {
      reject(error);
      return;
    }
    request.on('error', (error) => finish(error));
    request.setTimeout(60000, () => request.destroy(new Error('--plugin-url download timed out.')));
    request.end();
  });
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
  try {
    for (let redirectCount = 0; redirectCount <= 5; redirectCount++) {
      const { url: parsed, addresses } = await validateArchiveTarget(currentUrl, lookupImpl);
      if (!allowLoopbackHttp && isLoopbackUrl(parsed.toString())) {
        throw new Error('--plugin-url redirects from a public URL to loopback are blocked.');
      }
      if (visited.has(parsed.href)) throw new Error('--plugin-url redirect loop detected.');
      visited.add(parsed.href);
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
          result = { status: response.status, body: await boundedResponseBytes(response, limit) };
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
    throw new Error('--plugin-url archive has no plugin (expected .claude-plugin/plugin.json): ' + parsed.href);
  } catch (error) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}
