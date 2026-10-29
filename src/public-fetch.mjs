import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_TOOL_OUTPUT = 24 * 1024;
const MAX_PUBLIC_RESPONSE_BYTES = 1024 * 1024;

function isPrivateIPv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return true;
  const [a, b, c] = parts;
  return a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    // Non-global special-purpose/documentation ranges are blocked as well as RFC1918.
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113) ||
    (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

// Node's URL parser canonicalizes dotted IPv4-mapped IPv6 hosts to hex form,
// e.g. ::ffff:127.0.0.1 becomes ::ffff:7f00:1. Decode both representations
// before applying the IPv4 private/reserved-address policy.
function mappedIPv4Address(address) {
  const value = String(address || '').toLowerCase();
  if (!value.startsWith('::ffff:')) return null;
  const tail = value.slice(7);
  if (isIP(tail) === 4) return tail;
  const parts = tail.split(':');
  if (parts.length !== 2 || parts.some((part) => !/^[a-f0-9]{1,4}$/.test(part))) return null;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  return [(high >> 8) & 255, high & 255, (low >> 8) & 255, low & 255].join('.');
}

function isPrivateAddress(address) {
  const version = isIP(address);
  if (version === 4) return isPrivateIPv4(address);
  if (version === 6) {
    const value = address.toLowerCase();
    const mappedIPv4 = mappedIPv4Address(value);
    if (mappedIPv4) return isPrivateIPv4(mappedIPv4);
    return value === '::' || value === '::1' || value.startsWith('fc') || value.startsWith('fd') ||
      value.startsWith('fe8') || value.startsWith('fe9') || value.startsWith('fea') || value.startsWith('feb') ||
      value.startsWith('fec') || value.startsWith('ff') ||
      // Reserved/transition IPv6 ranges should not be used to bypass URL-fetch policy.
      value.startsWith('2001:0:') || value.startsWith('2001:1:') || value.startsWith('2001:2:') ||
      value.startsWith('2001:3:') || value.startsWith('2001:4:112:') || value.startsWith('2001:10:') ||
      value.startsWith('2001:20:') || value.startsWith('2001:db8:') || value.startsWith('2002:') ||
      value.startsWith('64:ff9b:') || value.startsWith('3fff:');
  }
  return true;
}

async function validatePublicUrl(raw, options = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Provide a valid public URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS links can be fetched.');
  if (url.username || url.password) throw new Error('URLs containing credentials are blocked.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal') throw new Error('Local and metadata URLs are blocked.');
  const ip = isIP(host);
  if (ip && isPrivateAddress(host)) throw new Error('Private-network addresses are blocked.');
  let addresses = null;
  if (!ip) {
    let records;
    try { records = await (options.lookupImpl || lookup)(host, { all: true, verbatim: true }); }
    catch { throw new Error('Could not resolve this public hostname.'); }
    if (!records.length || records.some((record) => isPrivateAddress(record.address))) {
      throw new Error('This hostname resolves to a private or reserved address and is blocked.');
    }
    // Pin the exact DNS answers that passed validation to prevent DNS rebinding.
    addresses = records.map((record) => ({ address: record.address, family: record.family || isIP(record.address) }));
  }
  return { url, addresses };
}

async function requestPublicUrl(url, addresses, signal) {
  return await new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const requestOptions = {
      method: 'GET',
      signal,
      headers: {
        'user-agent': 'OasisOSS/0.2 (+https://github.com/FAHTHIZ/oasis)',
        accept: 'text/plain,text/html,application/json,text/markdown,*/*;q=0.2'
      }
    };
    if (addresses && addresses.length) {
      requestOptions.lookup = (_hostname, lookupOptions, callback) => {
        if (typeof lookupOptions === 'function') {
          callback = lookupOptions;
          lookupOptions = {};
        }
        if (lookupOptions && lookupOptions.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      };
    }
    const request = transport(url, requestOptions, (response) => {
      const headers = {
        get(name) {
          const value = response.headers[String(name).toLowerCase()];
          return Array.isArray(value) ? value.join(', ') : (value === undefined ? null : String(value));
        }
      };
      const status = response.statusCode || 0;
      let total = 0;
      const chunks = [];
      let responseSettled = false;
      const finishResponse = (value, error) => {
        if (responseSettled) return;
        responseSettled = true;
        if (error) finish(error);
        else finish(null, value);
      };
      response.on('error', (error) => finishResponse(null, error));
      const declared = Number(headers.get('content-length') || 0);
      if (Number.isFinite(declared) && declared > MAX_PUBLIC_RESPONSE_BYTES) {
        finishResponse({ status, headers, body: '', tooLarge: true });
        response.destroy();
        return;
      }
      response.on('data', (chunk) => {
        total += chunk.length;
        if (total > MAX_PUBLIC_RESPONSE_BYTES) {
          finishResponse({ status, headers, body: '', tooLarge: true });
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => finishResponse({
        status, headers, body: Buffer.concat(chunks).toString('utf8'), tooLarge: false
      }));
    });
    request.on('error', (error) => finish(error));
    request.setTimeout(15000, () => request.destroy(new Error('Public URL request timed out.')));
    request.end();
  });
}

export async function fetchPublicUrl(raw, options = {}) {
  const { url, addresses } = await validatePublicUrl(raw, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await (options.requestImpl || requestPublicUrl)(url, addresses, controller.signal);
    if (response.tooLarge) return { url: url.toString(), error: 'Response exceeds the 1 MiB limit.' };
    const responseStatus = Number(response.status) || 0;
    if ([301, 302, 303, 307, 308].includes(responseStatus)) {
      const location = response.headers.get('location');
      return { url: url.toString(), status: responseStatus, redirect: location ? new URL(location, url).toString() : null, message: 'Redirects are not followed automatically. Validate and fetch the destination separately if appropriate.' };
    }
    if (responseStatus < 200 || responseStatus >= 300) return { url: url.toString(), status: responseStatus, error: 'The server returned an unsuccessful status.' };
    const type = response.headers.get('content-type') || '';
    if (!/(text\/|application\/json|application\/xml|application\/xhtml\+xml)/i.test(type)) return { url: url.toString(), status: responseStatus, contentType: type, error: 'The response is not an accepted text content type.' };
    const text = String(response.body || '');
    if (Buffer.byteLength(text, 'utf8') > MAX_PUBLIC_RESPONSE_BYTES) return { url: url.toString(), error: 'Response exceeds the 1 MiB limit.' };
    let content = text;
    if (/text\/html|application\/xhtml\+xml/i.test(type)) {
      content = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
        .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/tr)[^>]*>/gi, '\n')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
        .replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n');
    }
    return { url: url.toString(), status: responseStatus, contentType: type, content: content.slice(0, MAX_TOOL_OUTPUT), truncated: content.length > MAX_TOOL_OUTPUT };
  } finally { clearTimeout(timer); }
}
