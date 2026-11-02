// Outbound HTTP(S) proxy support for corporate networks.
//
// Node 22's built-in fetch ignores HTTPS_PROXY / HTTP_PROXY, so behind a proxy
// every model, MCP, OAuth, hook and telemetry request failed. installProxyFromEnv()
// replaces globalThis.fetch with one that sends requests through the configured
// proxy: a CONNECT tunnel for https:// targets (TLS stays end to end; the proxy
// never sees the request or the API key) and absolute-URI requests for http://.
// NO_PROXY is honoured, and loopback hosts always connect directly.
//
//   HTTPS_PROXY / https_proxy   proxy for https:// URLs
//   HTTP_PROXY  / http_proxy    proxy for http:// URLs (and https:// when HTTPS_PROXY is unset)
//   ALL_PROXY   / all_proxy     fallback for both
//   NO_PROXY    / no_proxy      comma/space list: host, .domain, *.domain, host:port, IP, CIDR, or *
//   OASIS_PROXY=0               ignore all of the above
//
// Custom CA bundles: Node reads NODE_EXTRA_CA_CERTS itself at startup.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { nodeFetch, OASIS_FETCH } from './loopback-fetch.mjs';

function first(env, ...names) {
  for (const name of names) {
    const value = env[name] ?? env[name.toLowerCase()];
    if (value != null && String(value).trim()) return String(value).trim();
  }
  return '';
}

/** Parse a proxy URL ("host:port" is read as http://host:port). Only http:// and https:// proxies are supported. */
export function parseProxyUrl(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  let url;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : 'http://' + value); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (!url.hostname) return null;
  return url;
}

function isLoopbackHost(host) {
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h) || h === '0.0.0.0';
}

function ipInCidr(ip, cidr) {
  const [base, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const family = net.isIP(base);
  if (!family || net.isIP(ip) !== family || !Number.isInteger(bits)) return false;
  const list = new net.BlockList();
  list.addSubnet(base, bits, family === 6 ? 'ipv6' : 'ipv4');
  return list.check(ip, family === 6 ? 'ipv6' : 'ipv4');
}

/** True when NO_PROXY (or loopback) says this URL must connect directly. */
export function bypassesProxy(target, noProxy = '') {
  const url = target instanceof URL ? target : new URL(String(target));
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isLoopbackHost(host)) return true;
  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  for (const rawEntry of String(noProxy || '').split(/[\s,]+/)) {
    let entry = rawEntry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    if (entry.includes('/') && net.isIP(host)) { if (ipInCidr(host, entry)) return true; continue; }
    let entryPort = '';
    const bracket = entry.match(/^\[([^\]]+)\](?::(\d+))?$/);
    if (bracket) { entry = bracket[1]; entryPort = bracket[2] || ''; }
    else if (!net.isIP(entry)) {
      const m = entry.match(/^(.*):(\d+)$/);
      if (m) { entry = m[1]; entryPort = m[2]; }
    }
    if (entryPort && entryPort !== port) continue;
    if (entry.startsWith('*.')) entry = entry.slice(1);
    if (entry.startsWith('.')) { if (host.endsWith(entry) || host === entry.slice(1)) return true; continue; }
    if (host === entry || host.endsWith('.' + entry)) return true;
  }
  return false;
}

/** The proxy URL to use for a target, or null to connect directly. */
export function proxyForUrl(target, env = process.env) {
  if (env.OASIS_PROXY === '0') return null;
  let url;
  try { url = target instanceof URL ? target : new URL(String(target)); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const raw = url.protocol === 'https:' ? first(env, 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY') : first(env, 'HTTP_PROXY', 'ALL_PROXY');
  const proxy = parseProxyUrl(raw);
  if (!proxy) return null;
  if (bypassesProxy(url, first(env, 'NO_PROXY'))) return null;
  return proxy;
}

function proxyAuthorization(proxy) {
  if (!proxy.username && !proxy.password) return null;
  return 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
}

/** Describe a proxy without its credentials (for doctor and logs). */
export function describeProxy(proxy) {
  if (!proxy) return 'none';
  return proxy.protocol + '//' + (proxy.username || proxy.password ? '***@' : '') + proxy.host;
}

function connectToProxy(proxy, signal) {
  return new Promise((resolve, reject) => {
    const port = Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80);
    const host = proxy.hostname.replace(/^\[|\]$/g, '');
    const socket = proxy.protocol === 'https:'
      ? tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] })
      : net.connect({ host, port });
    const onAbort = () => socket.destroy(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }));
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    socket.once(proxy.protocol === 'https:' ? 'secureConnect' : 'connect', () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(socket); });
    socket.once('error', (error) => { if (signal) signal.removeEventListener('abort', onAbort); reject(error); });
  });
}

/** Open a CONNECT tunnel through the proxy to host:port and return the raw socket. */
export async function openTunnel(proxy, host, port, { signal } = {}) {
  const socket = await connectToProxy(proxy, signal);
  const authority = (net.isIP(host) === 6 ? '[' + host + ']' : host) + ':' + port;
  const auth = proxyAuthorization(proxy);
  socket.write('CONNECT ' + authority + ' HTTP/1.1\r\nHost: ' + authority + '\r\n' + (auth ? 'Proxy-Authorization: ' + auth + '\r\n' : '') + '\r\n');
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const fail = (error) => { cleanup(); socket.destroy(); reject(error); };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 16384) return fail(new Error('The proxy sent an oversized CONNECT response.'));
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      cleanup();
      const statusLine = buffer.subarray(0, buffer.indexOf('\r\n')).toString('latin1');
      const status = Number((statusLine.match(/^HTTP\/1\.[01] (\d{3})/) || [])[1]);
      if (status !== 200) {
        socket.destroy();
        const hint = status === 407 ? ' (proxy authentication required: put credentials in the proxy URL, e.g. http://user:pass@proxy:8080)' : '';
        return reject(Object.assign(new Error('The proxy refused to connect to ' + authority + ': ' + (statusLine || 'no status line') + hint), { proxyStatus: status || null }));
      }
      const rest = buffer.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    const onError = (error) => fail(error);
    const onClose = () => fail(new Error('The proxy closed the connection during CONNECT.'));
    function cleanup() { socket.off('data', onData); socket.off('error', onError); socket.off('close', onClose); }
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

/** fetch() that routes through the env-configured proxy, falling back to `direct` for bypassed targets. */
export function createProxyFetch({ env = process.env, direct = globalThis.fetch } = {}) {
  return function proxyFetch(input, init = {}) {
    let url;
    try { url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url); } catch { return direct(input, init); }
    const proxy = proxyForUrl(url, env);
    // Request objects carry their own body/headers; only plain (url, init) calls are proxied.
    if (!proxy || (typeof input === 'object' && !(input instanceof URL))) return direct(input, init);
    if (init && init.body != null && typeof init.body !== 'string' && !(init.body instanceof Uint8Array) && !(init.body instanceof ArrayBuffer)) {
      if (typeof URLSearchParams !== 'undefined' && init.body instanceof URLSearchParams) {
        init = { ...init, body: init.body.toString(), headers: withDefaultHeader(init.headers, 'content-type', 'application/x-www-form-urlencoded;charset=UTF-8') };
      } else return direct(input, init);
    }
    return followRedirects(url, init, (target, request) => nodeFetch(target, request, (target, options, onResponse) => {
      if (target.protocol === 'https:') {
        const host = target.hostname.replace(/^\[|\]$/g, '');
        return openTunnel(proxy, host, Number(target.port) || 443, { signal: init.signal }).then((socket) => {
          // A one-request agent whose only connection is TLS over the tunnel; the
          // certificate is verified against the real host name as usual.
          const agent = new https.Agent({ keepAlive: false });
          agent.createConnection = () => tls.connect({ socket, servername: net.isIP(host) ? undefined : host, ALPNProtocols: ['http/1.1'] });
          return https.request(target, { ...options, agent }, onResponse);
        });
      }
      const auth = proxyAuthorization(proxy);
      const transport = proxy.protocol === 'https:' ? https : http;
      return Promise.resolve(transport.request({
        protocol: proxy.protocol,
        hostname: proxy.hostname.replace(/^\[|\]$/g, ''),
        port: Number(proxy.port) || (proxy.protocol === 'https:' ? 443 : 80),
        method: options.method,
        path: target.href,
        headers: { ...options.headers, host: target.host, ...(auth ? { 'proxy-authorization': auth } : {}) },
        timeout: 0,
        agent: false
      }, onResponse));
    }));
  };
}

// fetch()'s redirect modes: 'follow' (default, up to 20 hops), 'error', 'manual'.
// Like browsers, 303 (and 301/302 after POST) become GET without a body, and
// credentials are dropped when a redirect leaves the original origin.
async function followRedirects(url, init, send) {
  const mode = init.redirect || 'follow';
  let target = url;
  let request = init;
  for (let hop = 0; ; hop++) {
    const response = await send(target, request);
    if (![301, 302, 303, 307, 308].includes(response.status) || mode === 'manual') return withUrl(response, target);
    const location = response.headers.get('location');
    if (!location) return withUrl(response, target);
    if (mode === 'error') { await response.body?.cancel().catch(() => {}); throw new TypeError('fetch failed: redirect mode is set to error'); }
    if (hop >= 20) { await response.body?.cancel().catch(() => {}); throw new TypeError('fetch failed: too many redirects'); }
    await response.body?.cancel().catch(() => {});
    const next = new URL(location, target);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new TypeError('fetch failed: unsupported redirect scheme');
    const method = String(request.method || 'GET').toUpperCase();
    const toGet = response.status === 303 ? method !== 'HEAD' : (response.status === 301 || response.status === 302) && method === 'POST';
    const headers = {};
    const source = request.headers || {};
    if (typeof source.forEach === 'function' && !Array.isArray(source)) source.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    else for (const [k, v] of Object.entries(source)) headers[k.toLowerCase()] = v;
    if (next.origin !== target.origin) { delete headers.authorization; delete headers.cookie; delete headers['proxy-authorization']; }
    if (toGet) { delete headers['content-type']; delete headers['content-length']; }
    delete headers.host;
    request = { ...request, headers, ...(toGet ? { method: 'GET', body: undefined } : {}) };
    target = next;
  }
}

function withUrl(response, url) {
  try { Object.defineProperty(response, 'url', { value: url.href }); } catch {}
  return response;
}

function withDefaultHeader(headers, name, value) {
  const out = {};
  if (headers && typeof headers.forEach === 'function' && !Array.isArray(headers)) headers.forEach((v, k) => { out[k] = v; });
  else Object.assign(out, headers || {});
  if (!Object.keys(out).some((k) => k.toLowerCase() === name)) out[name] = value;
  return out;
}

let installed = false;
/**
 * Route globalThis.fetch through the proxy named by the environment. The check runs
 * per request, so proxy variables applied later (settings.json "env") still take
 * effect; with none set, requests go straight to the original fetch. Skipped with
 * OASIS_PROXY=0 or when Node handles proxies itself (NODE_USE_ENV_PROXY=1).
 * Returns the current proxy description, or null when none is configured.
 */
export function installProxyFromEnv(env = process.env) {
  if (!installed && env.OASIS_PROXY !== '0' && env.NODE_USE_ENV_PROXY !== '1') {
    const proxied = createProxyFetch({ env, direct: globalThis.fetch });
    proxied[OASIS_FETCH] = true;
    globalThis.fetch = proxied;
    installed = true;
  }
  return currentProxy(env);
}

/** The proxy that https:// requests would use right now (redacted), or null. */
export function currentProxy(env = process.env) {
  if (env.OASIS_PROXY === '0') return null;
  const proxy = parseProxyUrl(first(env, 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'));
  return proxy ? describeProxy(proxy) : null;
}
