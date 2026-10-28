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

function requireSafeEndpoint(url, label) {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopbackUrl(parsed.toString()))) throw new Error(label + ' must use HTTPS: ' + url);
  return parsed.toString();
}

export function parseWwwAuthenticate(header) {
  const out = {};
  for (const match of String(header || '').matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) out[match[1]] = match[2];
  return out;
}

async function getJson(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_METADATA_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      redirect: 'manual',
      signal: controller.signal
    });
    // Do not let discovery silently move to a different host via an HTTP redirect.
    if (!response.ok || (response.status >= 300 && response.status < 400) || !response.body) return null;
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_OAUTH_METADATA_BYTES) {
      await response.body.cancel().catch(() => {});
      return null;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OAUTH_METADATA_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch { return null; }
  finally { clearTimeout(timer); }
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
export async function discoverOAuth(serverUrl, { fetch: fetchImpl = fetch, resourceMetadataUrl = null } = {}) {
  let resourceMetadata = null;
  if (!resourceMetadataUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OAUTH_METADATA_TIMEOUT_MS);
    try {
      const probe = await fetchImpl(serverUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
        redirect: 'manual',
        signal: controller.signal
      });
      if (probe.status === 401) resourceMetadataUrl = parseWwwAuthenticate(probe.headers.get('www-authenticate')).resource_metadata || null;
      await probe.body?.cancel().catch(() => {});
    } catch {}
    finally { clearTimeout(timer); }
  }
  for (const candidate of resourceMetadataUrl ? [resourceMetadataUrl] : wellKnownUrls(serverUrl, 'oauth-protected-resource')) {
    resourceMetadata = await getJson(fetchImpl, candidate);
    if (resourceMetadata) break;
  }
  const issuer = resourceMetadata && Array.isArray(resourceMetadata.authorization_servers) && resourceMetadata.authorization_servers[0] || new URL(serverUrl).origin;
  let metadata = null;
  const issuerUrl = new URL(issuer);
  const candidates = [...wellKnownUrls(issuer, 'oauth-authorization-server'), ...wellKnownUrls(issuer, 'openid-configuration')];
  if (issuerUrl.pathname.replace(/\/$/, '')) candidates.push(issuer.replace(/\/$/, '') + '/.well-known/openid-configuration');
  for (const candidate of candidates) {
    metadata = await getJson(fetchImpl, candidate);
    if (metadata && metadata.authorization_endpoint && metadata.token_endpoint) break;
    metadata = null;
  }
  // Servers from before RFC 9728 support: default endpoints on the server origin.
  if (!metadata) metadata = { issuer: issuerUrl.origin, authorization_endpoint: issuerUrl.origin + '/authorize', token_endpoint: issuerUrl.origin + '/token', registration_endpoint: issuerUrl.origin + '/register' };
  return {
    issuer,
    authorizationEndpoint: requireSafeEndpoint(metadata.authorization_endpoint, 'Authorization endpoint'),
    tokenEndpoint: requireSafeEndpoint(metadata.token_endpoint, 'Token endpoint'),
    registrationEndpoint: metadata.registration_endpoint ? requireSafeEndpoint(metadata.registration_endpoint, 'Registration endpoint') : null,
    scopes: resourceMetadata && Array.isArray(resourceMetadata.scopes_supported) ? resourceMetadata.scopes_supported : null,
    pkce: !Array.isArray(metadata.code_challenge_methods_supported) || metadata.code_challenge_methods_supported.includes('S256')
  };
}

const b64url = (buffer) => Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function postForm(fetchImpl, url, form) {
  const response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(form).toString() });
  let body = null;
  try { body = await response.json(); } catch {}
  if (!response.ok || !body || !body.access_token) throw new Error('Token request failed (HTTP ' + response.status + ')' + (body && body.error ? ': ' + body.error + (body.error_description ? ' - ' + body.error_description : '') : '') + '.');
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

export function openInBrowser(url, { env = process.env, platform = process.platform } = {}) {
  if (env.OASIS_NO_BROWSER === '1') return false;
  const [command, args] = platform === 'darwin' ? ['open', [url]] : platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]] : ['xdg-open', [url]];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}

// Interactive sign-in. print(text) shows the URL; open(url) launches a browser.
export async function loginMcpServer(server, { env = process.env, fetch: fetchImpl = fetch, print = () => {}, open = (url) => openInBrowser(url, { env }), timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  if (!server || server.type !== 'http') throw new Error('Only HTTP MCP servers use sign-in; stdio servers get credentials from environment variables.');
  const oauth = server.oauth || {};
  const discovered = await discoverOAuth(server.url, { fetch: fetchImpl });
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
      const response = await fetchImpl(discovered.registrationEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ client_name: 'Oasis', redirect_uris: [redirectUri], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' })
      });
      const registered = await response.json().catch(() => null);
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
    const body = await postForm(fetchImpl, discovered.tokenEndpoint, { grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource, ...(clientSecret ? { client_secret: clientSecret } : {}) });
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
  const body = await postForm(fetchImpl, entry.tokenEndpoint, { grant_type: 'refresh_token', refresh_token: entry.refreshToken, client_id: entry.clientId, resource: entry.resource, ...(entry.clientSecret ? { client_secret: entry.clientSecret } : {}) });
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
