import { oasisVersion } from './version.mjs';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isNonPublicIpAddress } from './network-safety.mjs';
import { Agent as HttpsAgent } from 'node:https';
import { Agent as HttpAgent } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { proxyForUrl, openTunnel } from './proxy.mjs';
import { htmlToMarkdown } from './html-markdown.mjs';

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

// Behind a proxy the request still goes to the address that passed the
// private-network check: the CONNECT tunnel names that IP, never the host name,
// so the proxy's own DNS cannot steer it to an internal address. Plain http://
// is tunnelled too (an absolute-URI request would make the proxy rewrite Host).
async function proxiedAgent(url, addresses, signal, env) {
  const proxy = proxyForUrl(url, env);
  if (!proxy) return null;
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const ip = addresses && addresses.length ? addresses[0].address : host;
  const port = Number(url.port) || (url.protocol === 'https:' ? 443 : 80);
  const socket = await openTunnel(proxy, ip, port, { signal });
  if (url.protocol === 'https:') {
    const agent = new HttpsAgent({ keepAlive: false });
    agent.createConnection = () => tlsConnect({ socket, servername: isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] });
    return agent;
  }
  const agent = new HttpAgent({ keepAlive: false });
  agent.createConnection = () => socket;
  return agent;
}

async function requestPublicUrl(url, addresses, signal, env = process.env) {
  const agent = await proxiedAgent(url, addresses, signal, env);
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
        'user-agent': 'OasisOSS/' + oasisVersion() + ' (+https://github.com/FAHTHIZ/oasis)',
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
    if (agent) { requestOptions.agent = agent; delete requestOptions.lookup; }
    const onResponse = (response) => {
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
    };
    const request = transport(url, requestOptions, onResponse);
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
    const response = await (options.requestImpl || requestPublicUrl)(url, addresses, controller.signal, options.env || process.env);
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
    let title;
    let extracted;
    if (/text\/html|application\/xhtml\+xml/i.test(type) && !options.raw) {
      const converted = htmlToMarkdown(text, { url: url.toString(), extract: options.extract !== false });
      title = converted.title || undefined;
      extracted = converted.extracted;
      content = (title && !converted.titleInBody ? '# ' + title + '\n\n' : '') + converted.markdown;
    }
    const limit = Math.max(500, Math.min(MAX_TOOL_OUTPUT, Number(options.maxLength) || MAX_TOOL_OUTPUT));
    const start = Math.max(0, Math.floor(Number(options.startIndex) || 0));
    if (start > 0 && start >= content.length) return { url: url.toString(), status: responseStatus, contentType: type, title, error: 'start_index ' + start + ' is past the end of the content (' + content.length + ' characters).' };
    let end = Math.min(content.length, start + limit);
    // Prefer to break pages at a paragraph or line boundary.
    if (end < content.length) {
      const para = content.lastIndexOf('\n\n', end);
      const line = content.lastIndexOf('\n', end);
      if (para > start + limit * 0.6) end = para;
      else if (line > start + limit * 0.6) end = line;
    }
    const result = { url: url.toString(), status: responseStatus, contentType: type };
    if (title) result.title = title;
    if (extracted !== undefined) result.format = extracted ? 'markdown (main content)' : 'markdown';
    result.content = content.slice(start, end);
    result.truncated = end < content.length;
    if (start > 0) result.startIndex = start;
    if (result.truncated) {
      result.totalLength = content.length;
      result.nextStartIndex = end;
      result.note = 'Content continues. Call fetch_url again with start_index ' + end + ' to read more.';
    }
    return result;
  } finally { clearTimeout(timer); }
}
