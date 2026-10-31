import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isNonPublicIpAddress } from './network-safety.mjs';

const MAX_TOOL_OUTPUT = 24 * 1024;
const MAX_PUBLIC_RESPONSE_BYTES = 1024 * 1024;

function isPrivateAddress(address) {
  const version = isIP(String(address || '').replace(/^\[|\]$/g, ''));
  return version !== 4 && version !== 6 || isNonPublicIpAddress(address);
}

async function validatePublicUrl(raw, options = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Provide a valid public URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS links can be fetched.');
  if (url.username || url.password) throw new Error('URLs containing credentials are blocked.');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (!host) throw new Error('Provide a valid public URL.');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === 'metadata.google.internal' || host.endsWith('.internal') || host.endsWith('.home.arpa')) throw new Error('Local and metadata URLs are blocked.');
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
