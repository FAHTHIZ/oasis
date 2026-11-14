import { oasisVersion } from './version.mjs';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isBlockedAddress, isLocalHostname, normalizeHostname, pinnedRequest, resolvePublicAddresses } from './safe-http.mjs';
import { Agent as HttpsAgent } from 'node:https';
import { Agent as HttpAgent } from 'node:http';
import { connect as tlsConnect } from 'node:tls';
import { proxyForUrl, openTunnel } from './proxy.mjs';
import { htmlToMarkdown } from './html-markdown.mjs';

const MAX_TOOL_OUTPUT = 24 * 1024;
// Matches Claude Code's WebFetch download cap. Large article pages are
// several MiB of HTML (Wikipedia "United States" is ~3 MiB) but convert to a
// fraction of that; the converter runs in a worker with a timeout.
const MAX_PUBLIC_RESPONSE_BYTES = 10 * 1024 * 1024;

async function validatePublicUrl(raw, options = {}) {
  let url;
  try { url = new URL(raw); } catch { throw new Error('Provide a valid public URL.'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Only HTTP and HTTPS links can be fetched.');
  if (url.username || url.password) throw new Error('URLs containing credentials are blocked.');
  const host = normalizeHostname(url);
  if (!host) throw new Error('Provide a valid public URL.');
  if (isLocalHostname(host)) throw new Error('Local and metadata URLs are blocked.');
  const ip = isIP(host);
  if (ip && isBlockedAddress(host)) throw new Error('Private-network addresses are blocked.');
  let addresses = null;
  if (!ip) {
    // Pin the exact DNS answers that passed validation to prevent DNS rebinding.
    const resolved = await resolvePublicAddresses(host, { lookupImpl: options.lookupImpl || lookup });
    if (resolved.reason === 'unresolved') throw new Error('Could not resolve this public hostname.');
    if (resolved.reason === 'private') throw new Error('This hostname resolves to a private or reserved address and is blocked.');
    addresses = resolved.addresses;
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
  const response = await pinnedRequest(url, {
    addresses,
    agent: agent || undefined,
    signal,
    maxBytes: MAX_PUBLIC_RESPONSE_BYTES,
    timeoutMs: 15000,
    timeoutMessage: 'Public URL request timed out.',
    headers: {
      'user-agent': 'OasisOSS/' + oasisVersion() + ' (+https://github.com/FAHTHIZ/oasis)',
      accept: 'text/plain,text/html,application/json,text/markdown,*/*;q=0.2'
    }
  });
  return { status: response.status, headers: response.headers, body: response.tooLarge ? '' : response.body.toString('utf8'), tooLarge: response.tooLarge };
}

export async function fetchPublicUrl(raw, options = {}) {
  const { url, addresses } = await validatePublicUrl(raw, options);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await (options.requestImpl || requestPublicUrl)(url, addresses, controller.signal, options.env || process.env);
    if (response.tooLarge) return { url: url.toString(), error: 'Response exceeds the 10 MiB limit.' };
    const responseStatus = Number(response.status) || 0;
    if ([301, 302, 303, 307, 308].includes(responseStatus)) {
      const location = response.headers.get('location');
      return { url: url.toString(), status: responseStatus, redirect: location ? new URL(location, url).toString() : null, message: 'Redirects are not followed automatically. Validate and fetch the destination separately if appropriate.' };
    }
    if (responseStatus < 200 || responseStatus >= 300) return { url: url.toString(), status: responseStatus, error: 'The server returned an unsuccessful status.' };
    const type = response.headers.get('content-type') || '';
    if (!/(text\/|application\/json|application\/xml|application\/xhtml\+xml)/i.test(type)) return { url: url.toString(), status: responseStatus, contentType: type, error: 'The response is not an accepted text content type.' };
    const text = String(response.body || '');
    if (Buffer.byteLength(text, 'utf8') > MAX_PUBLIC_RESPONSE_BYTES) return { url: url.toString(), error: 'Response exceeds the 10 MiB limit.' };
    let content = text;
    let title;
    let extracted;
    let degraded;
    if (/text\/html|application\/xhtml\+xml/i.test(type) && !options.raw) {
      const converted = await htmlToMarkdown(text, { url: url.toString(), extract: options.extract !== false });
      title = converted.title || undefined;
      extracted = converted.extracted;
      degraded = converted.degraded;
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
    if (extracted !== undefined) result.format = degraded ? 'text' : extracted ? 'markdown (main content)' : 'markdown';
    if (degraded) result.note = 'HTML ' + degraded + '.';
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
