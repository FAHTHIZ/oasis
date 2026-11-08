// One SSRF-hardened HTTP client for every outbound request made on behalf of the
// model or an untrusted manifest: fetch_url, plugin archive downloads and MCP
// OAuth discovery/registration/token exchange.
//
// The guarantees, in one place instead of three hand-copied variants:
//   - local/internal hostnames and non-public IP literals are refused;
//   - a hostname is resolved once, every answer is checked, and the socket
//     lookup is pinned to exactly those answers (no DNS-rebinding window);
//   - response bodies are bounded both by Content-Length and while streaming;
//   - every request has a timeout and honours an AbortSignal.
// Callers keep their own user-facing wording; this module reports *why* a
// target was refused through a stable `reason` code.
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isNonPublicIpAddress } from './network-safety.mjs';

const LOCAL_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

/** Lower-cased hostname without IPv6 brackets or trailing dots. */
export function normalizeHostname(value) {
  const host = value instanceof URL ? value.hostname : String(value || '');
  return host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
}

/** Names that always mean "this machine or this private network". */
export function isLocalHostname(host) {
  const name = normalizeHostname(host);
  return name === 'localhost' || name === 'metadata.google.internal' || LOCAL_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/** True when an address is not a valid IP or is not a public destination. */
export function isBlockedAddress(address) {
  const text = String(address || '').replace(/^\[|\]$/g, '');
  const version = isIP(text);
  return (version !== 4 && version !== 6) || isNonPublicIpAddress(text);
}

/**
 * Resolve a public hostname and validate every DNS answer.
 * Returns { addresses } on success or { reason } where reason is
 * 'unresolved' (lookup failed or returned nothing) or 'private'.
 */
export async function resolvePublicAddresses(host, { lookupImpl = lookup } = {}) {
  let records;
  try { records = await lookupImpl(normalizeHostname(host), { all: true, verbatim: true }); }
  catch { return { reason: 'unresolved' }; }
  if (!Array.isArray(records) || !records.length) return { reason: 'unresolved' };
  if (records.some((record) => isBlockedAddress(record.address))) return { reason: 'private' };
  return { addresses: records.map((record) => ({ address: record.address, family: record.family || isIP(record.address) })) };
}

/** A net.connect-compatible lookup that only ever returns the vetted addresses. */
export function pinnedLookup(addresses) {
  return (_host, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    if (options && options.all) callback(null, addresses);
    else callback(null, addresses[0].address, addresses[0].family);
  };
}

function toHeaders(raw = {}) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, String(item));
    else headers.set(name, String(value));
  }
  return headers;
}

/**
 * Perform one HTTP(S) request without following redirects.
 * Resolves { status, headers (Headers), body (Buffer), tooLarge }.
 * When the body exceeds maxBytes the transfer is aborted, body is empty and
 * tooLarge is true; the status and headers are still reported.
 */
export function pinnedRequest(url, options = {}) {
  const parsed = url instanceof URL ? url : new URL(url);
  const {
    addresses = null,
    method = 'GET',
    headers = {},
    body,
    maxBytes = 1024 * 1024,
    timeoutMs = 15000,
    timeoutMessage = 'Request timed out.',
    signal,
    agent
  } = options;
  const hostname = normalizeHostname(parsed);
  const transport = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const requestOptions = {
      protocol: parsed.protocol,
      hostname,
      port: parsed.port || undefined,
      method,
      path: parsed.pathname + parsed.search,
      headers,
      signal
    };
    if (parsed.protocol === 'https:' && !isIP(hostname)) requestOptions.servername = hostname;
    if (agent) requestOptions.agent = agent;
    else if (addresses && addresses.length && !isIP(hostname)) requestOptions.lookup = pinnedLookup(addresses);
    let request;
    try {
      request = transport(requestOptions, (response) => {
        const status = response.statusCode || 0;
        const responseHeaders = toHeaders(response.headers);
        const tooLarge = () => { finish(null, { status, headers: responseHeaders, body: Buffer.alloc(0), tooLarge: true }); response.destroy(); };
        response.on('error', (error) => finish(error));
        const declared = Number(responseHeaders.get('content-length') || 0);
        if (Number.isFinite(declared) && declared > maxBytes) { tooLarge(); return; }
        const chunks = [];
        let total = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          total += chunk.length;
          if (total > maxBytes) { tooLarge(); return; }
          chunks.push(Buffer.from(chunk));
        });
        response.on('end', () => finish(null, { status, headers: responseHeaders, body: Buffer.concat(chunks, total), tooLarge: false }));
      });
    } catch (error) {
      reject(error);
      return;
    }
    request.on('error', (error) => finish(error));
    request.setTimeout(timeoutMs, () => request.destroy(new Error(timeoutMessage)));
    request.end(body === undefined || body === null ? undefined : body);
  });
}

/**
 * Read a WHATWG Response body with a byte cap. Returns a Buffer, or null when
 * the declared or streamed size exceeds maxBytes (the stream is cancelled).
 */
export async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => {});
    return null;
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
        return null;
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  return Buffer.concat(chunks, total);
}
