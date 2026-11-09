// `oasis doctor --network`: can this machine reach the services OASIS talks to?
//
// For the model provider, each remote MCP server in .mcp.json and GitHub (update
// checks), it reports the route (direct or which proxy), DNS, and the HTTP status
// of a bare request. No API key, token or MCP header is ever sent; any HTTP status
// (even 401/404) proves the network path works. Failures are explained in plain
// terms: DNS, refused, timeout, proxy authentication, or a certificate the machine
// does not trust (TLS-inspecting proxies; fix with NODE_EXTRA_CA_CERTS).
import { lookup } from 'node:dns/promises';
import { proxyForUrl, describeProxy } from './proxy.mjs';

const CERT_CODES = new Set(['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_UNTRUSTED', 'UNABLE_TO_GET_ISSUER_CERT', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID']);

function rootCause(error) {
  let current = error;
  for (let depth = 0; current && current.cause && depth < 5; depth++) current = current.cause;
  return current || error;
}

const CA_FIX = 'point NODE_EXTRA_CA_CERTS at your organisation\'s root CA file';

/** The likely cause of each certificate failure, and its fix. */
export function certificateAdvice(code) {
  const tag = ' (' + (code || 'certificate error') + ').';
  switch (code) {
    case 'CERT_HAS_EXPIRED':
      return 'The server certificate has expired' + tag + ' If the date on this computer is wrong, correct it; otherwise the server must renew its certificate.';
    case 'CERT_NOT_YET_VALID':
      return 'The server certificate is not valid yet' + tag + ' Check that the date and time on this computer are correct.';
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return 'The certificate does not match the host name' + tag + ' Check the URL for typos; a proxy that rewrites certificates can also cause this.';
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return 'The server certificate could not be verified' + tag + ' The server is most likely not sending its intermediate certificate (the server admin must add the full chain); if a TLS-inspecting proxy is in the way, ' + CA_FIX + '.';
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'UNABLE_TO_GET_ISSUER_CERT':
      return 'The server certificate is not trusted' + tag + ' This usually means a TLS-inspecting corporate proxy or antivirus; ' + CA_FIX + '.';
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
      return 'The server certificate is not trusted' + tag + ' The server uses a self-signed certificate; to trust it, ' + CA_FIX.replace('your organisation\'s root CA file', 'that certificate') + '.';
    default:
      return 'The server certificate is not trusted' + tag + ' Behind a TLS-inspecting proxy, ' + CA_FIX + '.';
  }
}

/** Plain-language explanation of a failed request. */
export function explainNetworkError(error, { proxied = false } = {}) {
  const cause = rootCause(error);
  const code = String(cause && cause.code || '');
  const message = String(cause && cause.message || error && error.message || error || '');
  if (error && error.name === 'AbortError' || /timed? ?out|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/i.test(code + ' ' + message)) {
    return { kind: 'timeout', detail: 'No answer in time.' + (proxied ? ' Check that the proxy allows this host.' : ' A firewall may be dropping the connection; if you need a proxy, set HTTPS_PROXY.') };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { kind: 'dns', detail: 'The host name could not be resolved (' + code + ').' + (proxied ? '' : ' On a network that only allows a proxy, set HTTPS_PROXY.') };
  if (code === 'ECONNREFUSED') return { kind: 'refused', detail: 'The connection was refused' + (proxied ? ' (by the proxy, or the proxy could not reach the host).' : '. Is the server running on that port?') };
  if (code === 'ECONNRESET' || code === 'EPIPE') return { kind: 'reset', detail: 'The connection was closed unexpectedly (' + code + '). A firewall or proxy may be blocking it.' };
  if (CERT_CODES.has(code) || /certificate/i.test(message)) {
    return { kind: 'certificate', detail: certificateAdvice(code) };
  }
  if (/\b407\b|proxy authentication/i.test(message)) return { kind: 'proxy-auth', detail: 'The proxy requires credentials: use http://user:pass@proxy:port in HTTPS_PROXY.' };
  if (/proxy refused/i.test(message)) return { kind: 'proxy', detail: message.slice(0, 200) };
  return { kind: 'error', detail: (code ? code + ': ' : '') + message.slice(0, 200) };
}

/** The endpoints worth checking for this configuration. URLs are reduced to their origin (no secrets in paths or queries). */
export function networkTargets({ config = {}, mcpServers = [], includeGitHub = true } = {}) {
  const targets = [];
  const add = (label, raw) => {
    let url;
    try { url = new URL(String(raw)); } catch { return; }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
    const origin = url.origin + '/';
    if (!targets.some((t) => t.url === origin)) targets.push({ label, url: origin });
  };
  if (config.baseURL && !['bedrock', 'vertex', 'foundry'].includes(String(config.protocol || ''))) add('Model provider', config.baseURL);
  if (config.protocol === 'bedrock') add('Model provider (Bedrock)', 'https://bedrock-runtime.' + (config.region || process.env.AWS_REGION || 'us-east-1') + '.amazonaws.com/');
  if (config.protocol === 'vertex') add('Model provider (Vertex AI)', 'https://' + ((config.region && config.region !== 'global') ? config.region + '-' : '') + 'aiplatform.googleapis.com/');
  for (const server of mcpServers) if (server && server.url) add('MCP ' + server.name, server.url);
  if (includeGitHub) add('GitHub (update checks)', 'https://api.github.com/');
  return targets;
}

/** Check one target. fetchImpl defaults to the (proxy-aware) global fetch. */
export async function checkTarget(target, { env = process.env, fetchImpl = globalThis.fetch, lookupImpl = lookup, timeoutMs = 10000 } = {}) {
  const url = new URL(target.url);
  const proxy = proxyForUrl(url, env);
  const result = { ...target, route: proxy ? 'via proxy ' + describeProxy(proxy) : 'direct', ok: false };
  if (!proxy) {
    try {
      const records = await lookupImpl(url.hostname.replace(/^\[|\]$/g, ''), { all: true });
      result.addresses = records.map((r) => r.address).slice(0, 3);
    } catch (error) {
      return { ...result, ...explainNetworkError(error) };
    }
  }
  const started = Date.now();
  try {
    // A bare GET: no Authorization, no cookies, no MCP headers.
    const response = await fetchImpl(url.toString(), { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'oasis-doctor' } });
    try { await response.body?.cancel(); } catch {}
    result.ms = Date.now() - started;
    if (response.status === 407) return { ...result, kind: 'proxy-auth', detail: 'The proxy requires credentials: use http://user:pass@proxy:port in HTTPS_PROXY.' };
    return { ...result, ok: true, status: response.status };
  } catch (error) {
    result.ms = Date.now() - started;
    return { ...result, ...explainNetworkError(error, { proxied: Boolean(proxy) }) };
  }
}

export async function runNetworkDoctor(options = {}) {
  const targets = options.targets || networkTargets(options);
  return Promise.all(targets.map((target) => checkTarget(target, options)));
}

export function formatNetworkReport(results, env = process.env) {
  const lines = ['Network check'];
  const proxyNote = proxyForUrl('https://example.com/', env);
  lines.push('  Proxy: ' + (proxyNote ? describeProxy(proxyNote) + ((env.NO_PROXY || env.no_proxy) ? ' (NO_PROXY: ' + (env.NO_PROXY || env.no_proxy) + ')' : '') : 'none'));
  if (env.NODE_EXTRA_CA_CERTS) lines.push('  Extra CA certificates: ' + env.NODE_EXTRA_CA_CERTS);
  for (const r of results) {
    const head = '  ' + (r.ok ? 'OK   ' : 'FAIL ') + r.label + ' — ' + r.url + ' (' + r.route + ')';
    lines.push(head);
    if (r.ok) lines.push('       reachable: HTTP ' + r.status + (r.ms != null ? ' in ' + r.ms + ' ms' : '') + (r.addresses ? '; resolves to ' + r.addresses.join(', ') : ''));
    else lines.push('       ' + r.detail);
  }
  if (!results.length) lines.push('  Nothing to check: no remote provider or MCP server is configured.');
  return lines.join('\n') + '\n';
}
