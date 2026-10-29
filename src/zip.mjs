// Minimal, dependency-free ZIP reader for plugin archives (--plugin-url). Supports stored and
// deflated entries (what `zip`, GitHub archive downloads and most tools produce). Paths that
// would escape the destination, symlinks and absurdly large archives are rejected.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isLoopbackUrl } from './config.mjs';
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
    const rawName = data.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
    // ZIP paths must be portable: a backslash is a separator on Windows but a
    // literal character on POSIX. Normalize before checking containment.
    const name = rawName.replace(/\\/g, '/');
    const parts = name.split('/');
    if (!name || name.includes(String.fromCharCode(0)) || name.startsWith('/') || /^[a-z]:/i.test(name) ||
        parts.some((part, i) => part === '.' || part === '..' || (!part && i !== parts.length - 1))) {
      throw new Error('Zip entry has an unsafe or ambiguous path: ' + rawName);
    }
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
function blockedIPv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

function embeddedIPv4(address) {
  const value = String(address || '').toLowerCase();
  let tail;
  if (value.startsWith('::ffff:')) tail = value.slice(7);
  else if (/^(?:0{1,4}:){5}ffff:/i.test(value)) tail = value.replace(/^(?:0{1,4}:){5}ffff:/i, '');
  else return null;
  if (isIP(tail) === 4) return tail;
  const parts = tail.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[a-f0-9]{1,4}$/.test(part))) return null;
  const high = Number.parseInt(parts[0], 16), low = Number.parseInt(parts[1], 16);
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.');
}

function blockedAddress(address) {
  const version = isIP(address);
  if (version === 4) return blockedIPv4(address);
  if (version !== 6) return true;
  const value = String(address).toLowerCase();
  const mapped = embeddedIPv4(value);
  if (mapped) return blockedIPv4(mapped);
  return value === '::' || value === '::1' || value.startsWith('100:') ||
    /^f[cd]/.test(value) || /^fe[89ab]/.test(value) || value.startsWith('fec0:') || value.startsWith('ff') ||
    /^2001:(?:0|1|2|3|10|20|db8):/.test(value) || value.startsWith('2001:4:112:') ||
    value.startsWith('2002:') || value.startsWith('64:ff9b:') || value.startsWith('3fff:');
}

async function validateArchiveTarget(rawUrl, lookupImpl = lookup) {
  let parsed;
  try { parsed = new URL(rawUrl); } catch { throw new Error('--plugin-url needs a valid public HTTP or HTTPS URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('--plugin-url accepts HTTP(S) URLs only; local file URLs are blocked.');
  if (parsed.username || parsed.password) throw new Error('--plugin-url must not contain embedded credentials.');
  const host = parsed.hostname.toLowerCase().replace(/^\\[|\\]$/g, '').replace(/\\.$/, '');
  const local = isLoopbackUrl(parsed.toString());
  if (parsed.protocol === 'http:' && !local) throw new Error('--plugin-url requires HTTPS for non-local downloads.');
  if (local) {
    const addresses = host === 'localhost' ? [{ address: '127.0.0.1', family: 4 }] : null;
    return { url: parsed, addresses };
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.home.arpa') || host === 'metadata.google.internal' || !host.includes('.')) {
    throw new Error('--plugin-url cannot target a local, internal, or single-label hostname.');
  }
  if (isIP(host)) {
    if (blockedAddress(host)) throw new Error('--plugin-url cannot target private or special-purpose IP addresses.');
    return { url: parsed, addresses: null };
  }
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
  const hostname = parsed.hostname.toLowerCase().replace(/^\\[|\\]$/g, '').replace(/\\.$/, '');
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
          finish(new Error('--plugin-url redirects are blocked. Use the final HTTPS archive URL directly.'));
          response.destroy();
          return;
        }
        if (response.statusCode < 200 || response.statusCode >= 300) {
          finish(new Error('--plugin-url download failed: HTTP ' + response.statusCode + ' for ' + parsed.href));
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
          if (!settled) finish(null, Buffer.concat(chunks, total));
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
  const { url: parsed, addresses } = await validateArchiveTarget(String(url || ''), lookupImpl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let buffer;
  try {
    if (fetchImpl === globalThis.fetch) {
      buffer = await fetchPinnedArchiveBytes(parsed, addresses, limit, controller.signal);
    } else {
      const response = await fetchImpl(parsed.href, { redirect: 'error', signal: controller.signal });
      if (response.status >= 300 && response.status < 400) throw new Error('--plugin-url redirects are blocked. Use the final HTTPS archive URL directly.');
      if (!response.ok) throw new Error('--plugin-url download failed: HTTP ' + response.status + ' for ' + parsed.href);
      buffer = await boundedResponseBytes(response, limit);
    }
  } finally {
    clearTimeout(timer);
  }

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
