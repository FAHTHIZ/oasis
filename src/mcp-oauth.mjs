// OAuth 2.1 sign-in for remote (HTTP) MCP servers, following the MCP
// authorization spec: protected-resource metadata (RFC 9728), authorization
// server metadata (RFC 8414 / OpenID discovery), dynamic client registration
// (RFC 7591), PKCE (S256), a loopback redirect, resource indicators (RFC 8707)
// and refresh tokens. Tokens are stored per server URL in
// <config>/mcp-auth.json with 0600 permissions and are never shown to the model.
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { getConfigDirectory, isLoopbackUrl } from './config.mjs';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_METADATA_TIMEOUT_MS = 10 * 1000;
const MAX_OAUTH_METADATA_BYTES = 256 * 1024;

function authFile(env = process.env) {
  return path.join(getConfigDirectory(env), 'mcp-auth.json');
}

async function readStore(env) {
  try {
    const data = JSON.parse(await readFile(authFile(env), 'utf8'));
    return data && typeof data.servers === 'object' ? data : { servers: {} };
  } catch { return { servers: {} }; }
}

async function writeStore(store, env) {
  const file = authFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.tmp';
  await writeFile(temp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  await rename(temp, file);
  try { await chmod(file, 0o600); } catch {}
}

export function canonicalResource(url) {
  const parsed = new URL(url);
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

export async function getStoredToken(serverUrl, env = process.env) {
  return (await readStore(env)).servers[canonicalResource(serverUrl)] || null;
}

export async function saveStoredToken(serverUrl, entry, env = process.env) {
  const store = await readStore(env);
  store.servers[canonicalResource(serverUrl)] = entry;
  await writeStore(store, env);
}

export async function deleteStoredToken(serverUrl, env = process.env) {
  const store = await readStore(env);
  const key = canonicalResource(serverUrl);
  const existed = Boolean(store.servers[key]);
  delete store.servers[key];
  await writeStore(store, env);
  return existed;
}

function privateIPv4(address) {
  const parts = address.split('.').map(Number);
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

function mappedIPv4(address) {
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

function privateAddress(address) {
  const version = isIP(address);
  if (version === 4) return privateIPv4(address);
  if (version !== 6) return true;
  const value = address.toLowerCase();
  const mapped = mappedIPv4(value);
  if (mapped) return privateIPv4(mapped);
  return value === '::' || value === '::1' || /^f[cd]/.test(value) ||
    /^fe[89ab]/.test(value) || value.startsWith('fec0:') || value.startsWith('ff') ||
    /^2001:(?:0|1|2|3|10|20|db8):/.test(value) || value.startsWith('2001:4:112:') ||
    value.startsWith('2002:') || value.startsWith('64:ff9b:') || value.startsWith('3fff:');
}

function oauthSafetyForServer(serverUrl, lookupImpl = lookup) {
  let localOrigin = null;
  try {
    const parsed = new URL(serverUrl);
    if (isLoopbackUrl(parsed.toString())) localOrigin = parsed.origin;
  } catch {}
  return { localOrigin, lookupImpl, resolvedAddresses: new Map() };
}

async function requireSafeEndpoint(url, label, safety = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(label + ' is not a valid URL.'); }
  if (parsed.username || parsed.password) throw new Error(label + ' must not include credentials.');
  const host = parsed.hostname.toLowerCase().replace(/^\\[|\\]$/g, '').replace(/\\.$/, '');
  const local = isLoopbackUrl(parsed.toString());
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local && safety.localOrigin === parsed.origin)) {
    throw new Error(label + ' must use HTTPS, except for the configured loopback MCP server origin.');
  }
  if (local) {
    if (!safety.localOrigin || safety.localOrigin !== parsed.origin) throw new Error(label + ' cannot target a different loopback origin.');
    if (host === 'localhost') safety.resolvedAddresses?.set(host, [{ address: '127.0.0.1', family: 4 }]);
    return parsed.toString();
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host.endsWith('.home.arpa') || host === 'metadata.google.internal') {
    throw new Error(label + ' cannot target a local or internal hostname.');
  }
  if (isIP(host)) {
    if (privateAddress(host)) throw new Error(label + ' cannot target a private or special-purpose address.');
    return parsed.toString();
  }
  let records;
  try { records = await (safety.lookupImpl || lookup)(host, { all: true, verbatim: true }); }
  catch { throw new Error(label + ' hostname could not be safely resolved.'); }
  if (!records.length || records.some((record) => privateAddress(record.address))) {
    throw new Error(label + ' resolves to a private or special-purpose address.');
  }
  safety.resolvedAddresses?.set(host, records.map((record) => ({ address: record.address, family: record.family || isIP(record.address) })));
  return parsed.toString();
}

export function parseWwwAuthenticate(header) {
  const out = {};
  for (const match of String(header || '').matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

async function readJsonBody(response, maxBytes = MAX_OAUTH_METADATA_BYTES) {
  if (!response.body) return null;
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body.cancel().catch(() => {});
    return null;
  }
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
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
  try { return JSON.parse(Buffer.concat(chunks, total).toString('utf8')); }
  catch { return null; }
}

function normalizedHostname(url) {
  return new URL(url).hostname.toLowerCase().replace(/^\\[|\\]$/g, '').replace(/\\.$/, '');
}

// The standard fetch implementation resolves hostnames again when it connects.
// For OAuth endpoints, that would reopen a DNS-rebinding window after the safety
// check. Resolve once, validate every answer, then pin the actual socket lookup to
// that exact approved address set. Injected fetch implementations remain available
// for deterministic tests and embedders.
async function fetchPinned(url, options = {}, safety = {}, maxBytes = MAX_OAUTH_METADATA_BYTES) {
  const parsed = new URL(url);
  const hostname = normalizedHostname(url);
  let addresses = safety.resolvedAddresses && safety.resolvedAddresses.get(hostname);
  if (!addresses && hostname === 'localhost' && safety.localOrigin === parsed.origin) {
    addresses = [{ address: '127.0.0.1', family: 4 }];
  }
  const transport = parsed.protocol === 'https:' ? httpsRequest : httpRequest;
  return await new Promise((resolve, reject) => {
    let settled = false;
    let total = 0;
    const chunks = [];
    const finish = (error, response) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(response);
    };
    const requestOptions = {
      protocol: parsed.protocol,
      hostname,
      port: parsed.port || undefined,
      method: options.method || 'GET',
      path: parsed.pathname + parsed.search,
      headers: options.headers || {},
      signal: options.signal
    };
    if (addresses && addresses.length && !isIP(hostname)) {
      requestOptions.lookup = (_host, lookupOptions, callback) => {
        if (typeof lookupOptions === 'function') {
          callback = lookupOptions;
          lookupOptions = {};
        }
        if (lookupOptions && lookupOptions.all) callback(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      };
    }
    let request;
    try {
      request = transport(parsed, requestOptions, (incoming) => {
        const headers = new Headers();
        for (const [name, raw] of Object.entries(incoming.headers || {})) {
          if (raw === undefined) continue;
          if (Array.isArray(raw)) for (const value of raw) headers.append(name, String(value));
          else headers.set(name, String(raw));
        }
        const status = incoming.statusCode || 502;
        const declared = Number(headers.get('content-length') || 0);
        if (Number.isFinite(declared) && declared > maxBytes) {
          finish(null, new Response(null, { status, headers }));
          incoming.destroy();
          return;
        }
        incoming.on('data', (chunk) => {
          if (settled) return;
          total += chunk.length;
          if (total > maxBytes) {
            finish(null, new Response(null, { status, headers }));
            incoming.destroy();
            return;
          }
          chunks.push(Buffer.from(chunk));
        });
        incoming.on('error', (error) => finish(error));
        incoming.on('end', () => {
          if (settled) return;
          const body = Buffer.concat(chunks, total);
          finish(null, new Response(body.length ? body : null, { status, headers }));
        });
      });
    } catch (error) {
      reject(error);
      return;
    }
    request.on('error', (error) => finish(error));
    request.setTimeout(OAUTH_METADATA_TIMEOUT_MS, () => request.destroy(new Error('OAuth request timed out.')));
    request.end(options.body === undefined ? undefined : options.body);
  });
}

async function safeOAuthFetch(fetchImpl, url, options = {}, safety = {}, maxBytes = MAX_OAUTH_METADATA_BYTES) {
  if (fetchImpl !== globalThis.fetch) return await fetchImpl(url, { ...options, redirect: 'manual' });
  return await fetchPinned(url, { ...options, redirect: 'manual' }, safety, maxBytes);
}

async function fetchBoundedJson(fetchImpl, url, options = {}, maxBytes = MAX_OAUTH_METADATA_BYTES, safety = {}) {
  await requireSafeEndpoint(url, 'OAuth request URL', safety);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_METADATA_TIMEOUT_MS);
  try {
    const response = await safeOAuthFetch(fetchImpl, url, { ...options, signal: controller.signal }, safety, maxBytes);
    // Do not let discovery, registration or token exchange silently cross hosts via redirects.
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => {});
      return { response, body: null };
    }
    return { response, body: await readJsonBody(response, maxBytes) };
  } catch (error) {
    if (error && error.name === 'AbortError') throw new Error('OAuth request timed out.');
    throw error;
  } finally { clearTimeout(timer); }
}

async function getJson(fetchImpl, url, safety = {}) {
  try {
    const { response, body } = await fetchBoundedJson(fetchImpl, url, { headers: { accept: 'application/json' } }, MAX_OAUTH_METADATA_BYTES, safety);
    if (!response.ok) return null;
    return body;
  } catch { return null; }
}

function wellKnownUrls(base, suffix) {
  const url = new URL(base);
  const pathPart = url.pathname.replace(/\/$/, '');
  const list = [];
  if (pathPart) list.push(url.origin + '/.well-known/' + suffix + pathPart);
  list.push(url.origin + '/.well-known/' + suffix);
  return list;
}

// Finds the authorization server for an MCP server URL.
export async function discoverOAuth(serverUrl, { fetch: fetchImpl = fetch, resourceMetadataUrl = null, lookupImpl = lookup } = {}) {
  const safety = oauthSafetyForServer(serverUrl, lookupImpl);
  await requireSafeEndpoint(serverUrl, 'MCP server URL', safety);
  let resourceMetadata = null;
  if (!resourceMetadataUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OAUTH_METADATA_TIMEOUT_MS);
    try {
      const probe = await safeOAuthFetch(fetchImpl, serverUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
        redirect: 'manual',
        signal: controller.signal
      }, safety, MAX_OAUTH_METADATA_BYTES);
      if (probe.status === 401) resourceMetadataUrl = parseWwwAuthenticate(probe.headers.get('www-authenticate')).resource_metadata || null;
      await probe.body?.cancel().catch(() => {});
    } catch {}
    finally { clearTimeout(timer); }
  }
  for (const candidate of resourceMetadataUrl ? [resourceMetadataUrl] : wellKnownUrls(serverUrl, 'oauth-protected-resource')) {
    resourceMetadata = await getJson(fetchImpl, candidate, safety);
    if (resourceMetadata) break;
  }
  const issuer = resourceMetadata && Array.isArray(resourceMetadata.authorization_servers) && resourceMetadata.authorization_servers[0] || new URL(serverUrl).origin;
  let metadata = null;
  const issuerUrl = new URL(await requireSafeEndpoint(issuer, 'OAuth issuer', safety));
  const candidates = [...wellKnownUrls(issuer, 'oauth-authorization-server'), ...wellKnownUrls(issuer, 'openid-configuration')];
  if (issuerUrl.pathname.replace(/\/$/, '')) candidates.push(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
  for (const candidate of candidates) {
    metadata = await getJson(fetchImpl, candidate, safety);
    if (metadata && metadata.authorization_endpoint && metadata.token_endpoint) break;
    metadata = null;
  }
  // Servers from before RFC 9728 support: default endpoints on the server origin.
  if (!metadata) metadata = { issuer: issuerUrl.origin, authorization_endpoint: issuerUrl.origin + '/authorize', token_endpoint: issuerUrl.origin + '/token', registration_endpoint: issuerUrl.origin + '/register' };
  return {
    issuer,
    authorizationEndpoint: await requireSafeEndpoint(metadata.authorization_endpoint, 'Authorization endpoint', safety),
    tokenEndpoint: await requireSafeEndpoint(metadata.token_endpoint, 'Token endpoint', safety),
    registrationEndpoint: metadata.registration_endpoint ? await requireSafeEndpoint(metadata.registration_endpoint, 'Registration endpoint', safety) : null,
    scopes: resourceMetadata && Array.isArray(resourceMetadata.scopes_supported) ? resourceMetadata.scopes_supported : null,
    pkce: !Array.isArray(metadata.code_challenge_methods_supported) || metadata.code_challenge_methods_supported.includes('S256')
  };
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function postForm(fetchImpl, url, form, safety = {}) {
  const { response, body } = await fetchBoundedJson(fetchImpl, url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString()
  }, MAX_OAUTH_METADATA_BYTES, safety);
  const oauthError = body && body.error
    ? ': ' + String(body.error).slice(0, 100) + (body.error_description ? ' - ' + String(body.error_description).slice(0, 300) : '')
    : '';
  if (!response.ok || !body || !body.access_token) throw new Error('Token request failed (HTTP ' + response.status + ')' + oauthError + '.');
  return body;
}

function tokenEntry(body, base) {
  return {
    ...base,
    accessToken: body.access_token,
    refreshToken: body.refresh_token || base.refreshToken || null,
    tokenType: body.token_type || 'Bearer',
    scope: body.scope || base.scope || null,
    expiresAt: body.expires_in ? Date.now() + Number(body.expires_in) * 1000 : null,
    obtainedAt: new Date().toISOString()
  };
}

export function openInBrowser(url, { env = process.env, platform = process.platform, spawnImpl = spawn } = {}) {
  if (env.OASIS_NO_BROWSER === '1') return false;
  // Do not route an OAuth URL through cmd.exe. The URL contains query-string
  // ampersands by design; cmd /c start would interpret unquoted metacharacters
  // as command separators. explorer.exe opens the URL through the OS handler
  // without introducing a command shell.
  const [command, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['explorer.exe', [url]] : ['xdg-open', [url]];
  try {
    const child = spawnImpl(command, args, { shell: false, stdio: 'ignore', detached: true, windowsHide: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

// Interactive sign-in. print(text) shows the URL; open(url) launches a browser.
export async function loginMcpServer(server, { env = process.env, fetch: fetchImpl = fetch, print = () => {}, open = (url) => openInBrowser(url, { env }), timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  if (!server || server.type !== 'http') throw new Error('Only HTTP MCP servers use sign-in; stdio servers get credentials from environment variables.');
  const oauth = server.oauth || {};
  const safety = oauthSafetyForServer(server.url);
  const discovered = await discoverOAuth(server.url, { fetch: fetchImpl, lookupImpl: safety.lookupImpl });
  const verifier = b64url(randomBytes(32));
  const challenge = b64url(createHash('sha256').update(verifier).digest());
  const state = b64url(randomBytes(16));
  let finish;
  let fail;
  const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  const callback = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const error = url.searchParams.get('error');
    const ok = !error && url.searchParams.get('state') === state && url.searchParams.get('code');
    res.writeHead(ok ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><title>Oasis</title><body style="font-family:sans-serif;padding:2rem">' + (ok ? 'Signed in to ' + server.name.replace(/[<>&]/g, '') + '. You can close this tab and return to Oasis.' : 'Sign-in failed. Return to Oasis and try again.') + '</body>');
    if (error) fail(new Error('The server refused sign-in: ' + error + (url.searchParams.get('error_description') ? ' - ' + url.searchParams.get('error_description') : '')));
    else if (url.searchParams.get('state') !== state) fail(new Error('Sign-in state did not match; try again.'));
    else if (ok) finish(url.searchParams.get('code'));
  });
  await new Promise((resolve, reject) => { callback.once('error', reject); callback.listen(Number(oauth.callbackPort) || 0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => fail(new Error('Timed out waiting for sign-in in the browser.')), timeoutMs);
  try {
    const redirectUri = 'http://127.0.0.1:' + callback.address().port + '/callback';
    let clientId = oauth.clientId || null;
    let clientSecret = oauth.clientSecret || null;
    if (!clientId) {
      if (!discovered.registrationEndpoint) throw new Error('This server does not support automatic client registration. Add "oauth": {"clientId": "..."} to its .mcp.json entry.');
      const { response, body: registered } = await fetchBoundedJson(fetchImpl, discovered.registrationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_name: 'Oasis', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' })
      }, MAX_OAUTH_METADATA_BYTES, safety);
      if (!response.ok || !registered || !registered.client_id) throw new Error('Client registration failed (HTTP ' + response.status + ').');
      clientId = registered.client_id;
      clientSecret = registered.client_secret || null;
    }
    const resource = canonicalResource(server.url);
    const scopes = Array.isArray(oauth.scopes) ? oauth.scopes : typeof oauth.scopes === 'string' ? oauth.scopes.split(/\s+/) : discovered.scopes;
    const authorize = new URL(discovered.authorizationEndpoint);
    authorize.searchParams.set('response_type', 'code');
    authorize.searchParams.set('client_id', clientId);
    authorize.searchParams.set('redirect_uri', redirectUri);
    authorize.searchParams.set('state', state);
    authorize.searchParams.set('code_challenge', challenge);
    authorize.searchParams.set('code_challenge_method', 'S256');
    authorize.searchParams.set('resource', resource);
    if (scopes && scopes.length) authorize.searchParams.set('scope', scopes.join(' '));
    print('Sign in to ' + server.name + ' in your browser:\n  ' + authorize.toString() + '\nWaiting for the browser to finish (up to ' + Math.round(timeoutMs / 60000) + ' minutes)...');
    open(authorize.toString());
    const code = await result;
    const body = await postForm(fetchImpl, discovered.tokenEndpoint, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource, ...(clientSecret ? { client_secret: clientSecret } : {}) }, safety);
    const entry = tokenEntry(body, { server: server.name, resource, clientId, clientSecret, tokenEndpoint: discovered.tokenEndpoint, issuer: discovered.issuer });
    await saveStoredToken(server.url, entry, env);
    return { ok: true, server: server.name, scope: entry.scope, expiresAt: entry.expiresAt };
  } finally {
    clearTimeout(timer);
    callback.close();
  }
}

export async function refreshStoredToken(serverUrl, { env = process.env, fetch: fetchImpl = fetch } = {}) {
  const entry = await getStoredToken(serverUrl, env);
  if (!entry || !entry.refreshToken) return null;
  const safety = oauthSafetyForServer(serverUrl);
  const body = await postForm(fetchImpl, entry.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: entry.refreshToken, client_id: entry.clientId, resource: entry.resource, ...(entry.clientSecret ? { client_secret: entry.clientSecret } : {}) }, safety);
  const next = tokenEntry(body, entry);
  await saveStoredToken(serverUrl, next, env);
  return next;
}

// Bearer header for a request, refreshing a token that expires within a minute.
export async function oauthHeader(serverUrl, { env = process.env, fetch: fetchImpl = fetch } = {}) {
  let entry = await getStoredToken(serverUrl, env);
  if (!entry) return null;
  if (entry.expiresAt && entry.expiresAt - Date.now() < 60000 && entry.refreshToken) {
    try { entry = await refreshStoredToken(serverUrl, { env, fetch: fetchImpl }); } catch { /* fall back to the stored token; a 401 will ask for login */ }
  }
  return entry && entry.accessToken ? 'Bearer ' + entry.accessToken : null;
}
