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
import net from 'node:net';
import tls from 'node:tls';
import { OASIS_FETCH } from './loopback-fetch.mjs';

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

// Proxied requests use undici's fetch with a ProxyAgent dispatcher (undici is
// the library behind Node's own fetch). It handles every body and Request
// type, redirects (dropping credentials across origins, per the Fetch spec),
// CONNECT tunnels for https:// (TLS stays end to end; the proxy never sees the
// request or the API key), and absolute-URI forwarding for http:// targets.
// OASIS keeps the policy: which proxy, NO_PROXY (with CIDR), loopback direct.
// undici is imported on the first proxied request (~80 ms), not at startup.
let undiciModule = null;
const loadUndici = () => (undiciModule ??= import('undici'));
const agents = new Map();
function agentFor(proxy, ProxyAgent) {
  const key = proxy.href;
  if (!agents.has(key)) {
    const uri = new URL(proxy.href);
    uri.username = ''; uri.password = '';
    agents.set(key, new ProxyAgent({
      uri: uri.href,
      token: proxyAuthorization(proxy) || undefined,
      // Plain http:// targets are forwarded, not tunnelled: many proxies only
      // allow CONNECT to port 443.
      proxyTunnel: false,
      // Model streams can stay quiet for minutes; callers set their own timeouts.
      headersTimeout: 0,
      bodyTimeout: 0
    }));
  }
  return agents.get(key);
}

function refusalHint(error) {
  const text = String(error && (error.cause && error.cause.message || error.message) || '');
  return /\b407\b/.test(text) ? ' (proxy authentication required: put credentials in the proxy URL, e.g. http://user:pass@proxy:8080)' : '';
}

/** fetch() that routes through the env-configured proxy, falling back to `direct` for bypassed targets. */
export function createProxyFetch({ env = process.env, direct = globalThis.fetch } = {}) {
  return async function proxyFetch(input, init = {}) {
    const isRequest = input && typeof input === 'object' && !(input instanceof URL) && typeof input.url === 'string';
    let url;
    try { url = new URL(isRequest ? input.url : String(input)); } catch { return direct(input, init); }
    const proxy = proxyForUrl(url, env);
    if (!proxy) return direct(input, init);
    // A Request from Node's bundled fetch is a different class than undici's,
    // so pass its parts explicitly.
    const request = isRequest
      ? { method: input.method, headers: input.headers, body: input.body, duplex: input.body ? 'half' : undefined, redirect: input.redirect, signal: input.signal, ...init }
      : init;
    try {
      const { fetch: undiciFetch, ProxyAgent } = await loadUndici();
      return await undiciFetch(url, { ...request, dispatcher: agentFor(proxy, ProxyAgent) });
    } catch (error) {
      const hint = refusalHint(error);
      if (hint && error instanceof Error) error.message += hint;
      throw error;
    }
  };
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
