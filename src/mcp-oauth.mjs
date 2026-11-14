// OAuth 2.1 sign-in for remote (HTTP) MCP servers. The protocol work (RFC 9728
// protected-resource metadata, RFC 8414 / OpenID discovery, client ID metadata
// documents or RFC 7591 dynamic registration, PKCE, RFC 8707 resource
// indicators, RFC 9207 issuer checks, scope selection and step-up, refresh) is
// done by the official MCP client SDK (@modelcontextprotocol/client), which
// passes the MCP conformance suite. OASIS adds the endpoint guard below, the
// loopback callback, and the token store: tokens are kept per server URL in
// <config>/mcp-auth.json with 0600 permissions and are never shown to the model.
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { isBlockedAddress, isLocalHostname, normalizeHostname, pinnedRequest, readBoundedBody, resolvePublicAddresses } from './safe-http.mjs';
import path from 'node:path';
import { getConfigDirectory, isLoopbackUrl } from './config.mjs';
import { replaceFileDurably } from './atomic-write.mjs';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;
const OAUTH_METADATA_TIMEOUT_MS = 10 * 1000;
const MAX_OAUTH_METADATA_BYTES = 256 * 1024;

function authFile(env = process.env) {
  return path.resolve(getConfigDirectory(env), 'mcp-auth.json');
}

async function readStore(env) {
  const file = authFile(env);
  let raw;
  try { raw = await readFile(file, 'utf8'); }
  catch (error) {
    if (error && error.code === 'ENOENT') return { servers: {} };
    throw new Error('Could not read MCP OAuth token store: ' + error.message);
  }
  let data;
  try { data = JSON.parse(raw); }
  catch {
    throw new Error('MCP OAuth token store contains invalid JSON; preserving the existing file instead of overwriting saved tokens.');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data) ||
      !data.servers || typeof data.servers !== 'object' || Array.isArray(data.servers)) {
    throw new Error('MCP OAuth token store has an invalid structure; refusing to overwrite it.');
  }
  return data;
}

const storeQueues = new Map();

function updateStore(env, mutate) {
  const file = authFile(env);
  const previous = storeQueues.get(file) || Promise.resolve();
  const operation = previous.catch(() => {}).then(async () => {
    const store = await readStore(env);
    const result = mutate(store);
    await writeStore(store, env);
    return result;
  });
  let queued;
  queued = operation.finally(() => {
    if (storeQueues.get(file) === queued) storeQueues.delete(file);
  });
  storeQueues.set(file, queued);
  return queued;
}

async function writeStore(store, env) {
  const file = authFile(env);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await replaceFileDurably(file, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
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
  return await updateStore(env, (store) => {
    store.servers[canonicalResource(serverUrl)] = entry;
  });
}

export async function deleteStoredToken(serverUrl, env = process.env) {
  return await updateStore(env, (store) => {
    const key = canonicalResource(serverUrl);
    const existed = Boolean(store.servers[key]);
    delete store.servers[key];
    return existed;
  });
}

function oauthSafetyForServer(serverUrl, lookupImpl = lookup) {
  let localOrigin = null;
  try {
    const parsed = new URL(serverUrl);
    if (isLoopbackUrl(parsed.toString())) localOrigin = parsed.origin;
  } catch {}
  // Opt-in for local development authorization servers (Keycloak, the MCP conformance
  // suite) that listen on a different loopback port than the MCP server itself.
  const allowLoopback = process.env.OASIS_MCP_OAUTH_ALLOW_LOOPBACK === '1';
  return { localOrigin, allowLoopback, lookupImpl, resolvedAddresses: new Map() };
}

async function requireSafeEndpoint(url, label, safety = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { throw new Error(label + ' is not a valid URL.'); }
  if (parsed.username || parsed.password) throw new Error(label + ' must not include credentials.');
  const host = normalizeHostname(parsed);
  const local = isLoopbackUrl(parsed.toString());
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local && (safety.allowLoopback || safety.localOrigin === parsed.origin))) {
    throw new Error(label + ' must use HTTPS, except for the configured loopback MCP server origin.');
  }
  if (local) {
    if (!safety.allowLoopback && (!safety.localOrigin || safety.localOrigin !== parsed.origin)) throw new Error(label + ' cannot target a different loopback origin.');
    if (host === 'localhost') safety.resolvedAddresses?.set(host, [{ address: '127.0.0.1', family: 4 }]);
    return parsed.toString();
  }
  if (isLocalHostname(host)) throw new Error(label + ' cannot target a local or internal hostname.');
  if (isIP(host)) {
    if (isBlockedAddress(host)) throw new Error(label + ' cannot target a private or special-purpose address.');
    return parsed.toString();
  }
  const resolved = await resolvePublicAddresses(host, { lookupImpl: safety.lookupImpl || lookup });
  if (resolved.reason === 'unresolved') throw new Error(label + ' hostname could not be safely resolved.');
  if (resolved.reason === 'private') throw new Error(label + ' resolves to a private or special-purpose address.');
  safety.resolvedAddresses?.set(host, resolved.addresses);
  return parsed.toString();
}

// The standard fetch implementation resolves hostnames again when it connects.
// For OAuth endpoints, that would reopen a DNS-rebinding window after the safety
// check. Resolve once, validate every answer, then pin the actual socket lookup to
// that exact approved address set. Injected fetch implementations remain available
// for deterministic tests and embedders.
async function fetchPinned(url, options = {}, safety = {}, maxBytes = MAX_OAUTH_METADATA_BYTES) {
  const parsed = new URL(url);
  const hostname = normalizeHostname(parsed);
  let addresses = safety.resolvedAddresses && safety.resolvedAddresses.get(hostname);
  if (!addresses && hostname === 'localhost' && (safety.allowLoopback || safety.localOrigin === parsed.origin)) {
    addresses = [{ address: '127.0.0.1', family: 4 }];
  }
  const result = await pinnedRequest(parsed, {
    addresses,
    method: options.method || 'GET',
    headers: options.headers || {},
    body: options.body,
    signal: options.signal,
    maxBytes,
    timeoutMs: OAUTH_METADATA_TIMEOUT_MS,
    timeoutMessage: 'OAuth request timed out.'
  });
  // An oversized body is reported with an empty body; readBoundedBody below
  // then sees the declared length or the guarded caller treats it as too large.
  if (result.tooLarge) {
    const headers = new Headers(result.headers);
    headers.set('content-length', String(maxBytes + 1));
    return new Response(null, { status: result.status || 502, headers });
  }
  const status = result.status || 502;
  return new Response(result.body.length && !NULL_BODY_STATUS.has(status) ? result.body : null, { status, headers: result.headers });
}

// ---------- Guarded fetch for OAuth endpoints ----------
//
// Discovery, registration, token exchange and refresh are done by the official
// MCP client SDK (@modelcontextprotocol/client). Every request it makes to an
// OAuth endpoint goes through this guard first: HTTPS only (loopback only for the
// MCP server's own origin), no private or internal destinations, DNS answers
// pinned to the checked addresses, no redirects, bounded bodies and a timeout.
// A blocked or failed metadata GET looks like a 404 so the SDK falls back to the
// next discovery candidate; a blocked POST (registration, token) is an error.

function normalizeOAuthTimeout(value = OAUTH_METADATA_TIMEOUT_MS) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(30000, Math.max(1, Math.trunc(parsed)))
    : OAUTH_METADATA_TIMEOUT_MS;
}

function requestUrl(input) {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return String(input && input.url || input);
}

function plainHeaders(headers) {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...headers };
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

// Refresh-token grants in flight, keyed by token endpoint and request body.
// Several requests that hit a 401 at once each ask the SDK to refresh; with
// refresh-token rotation only the first may use the old token, and the others
// would fail and wipe the new one. They share one token request instead.
const refreshesInFlight = new Map();

function refreshGrantBody(init) {
  const body = init && init.body;
  const text = body instanceof URLSearchParams ? body.toString() : typeof body === 'string' ? body : '';
  return /(?:^|&)grant_type=refresh_token(?:&|$)/.test(text) ? text : '';
}

export function createOAuthFetch(serverUrl, { fetch: fetchImpl = globalThis.fetch, lookupImpl = lookup, fetchTimeoutMs = OAUTH_METADATA_TIMEOUT_MS } = {}) {
  const safety = oauthSafetyForServer(serverUrl, lookupImpl);
  const timeoutMs = normalizeOAuthTimeout(fetchTimeoutMs);
  const guarded = async (input, init = {}) => {
    const refreshBody = String(init.method || 'GET').toUpperCase() === 'POST' ? refreshGrantBody(init) : '';
    if (!refreshBody) return await guardedOnce(input, init);
    const key = requestUrl(input) + '\n' + refreshBody;
    let shared = refreshesInFlight.get(key);
    if (!shared) {
      // A refresh is not cancelled with the request that started it: the server
      // may already have rotated the token, and dropping its answer would lose
      // the only copy. The OAuth timeout still bounds it.
      const { signal: _signal, ...rest } = init;
      shared = guardedOnce(input, rest).then(async (response) => ({ status: response.status, headers: response.headers, body: response.body ? Buffer.from(await response.arrayBuffer()) : null }));
      refreshesInFlight.set(key, shared);
      shared.finally(() => { if (refreshesInFlight.get(key) === shared) refreshesInFlight.delete(key); }).catch(() => {});
    }
    const { status, headers, body } = await shared;
    return new Response(body && body.length ? body : null, { status, headers });
  };
  const guardedOnce = async (input, init = {}) => {
    const url = requestUrl(input);
    const method = String(init.method || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    const soft = method === 'GET' || method === 'HEAD';
    try { await requireSafeEndpoint(url, 'OAuth request URL', safety); }
    catch (error) {
      if (soft) return new Response(null, { status: 404 });
      throw error;
    }
    const controller = new AbortController();
    const outer = init.signal;
    if (outer) {
      if (outer.aborted) controller.abort(outer.reason);
      else outer.addEventListener('abort', () => controller.abort(outer.reason), { once: true });
    }
    const timer = setTimeout(() => controller.abort(new Error('OAuth request timed out.')), timeoutMs);
    try {
      const headers = plainHeaders(init.headers);
      let body = init.body;
      if (body instanceof URLSearchParams) {
        body = body.toString();
        if (!Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) headers['content-type'] = 'application/x-www-form-urlencoded';
      }
      const options = { method, headers, ...(body === undefined || body === null ? {} : { body }), redirect: 'manual', signal: controller.signal };
      const response = fetchImpl !== globalThis.fetch
        ? await fetchImpl(url, options)
        : await fetchPinned(url, options, safety, MAX_OAUTH_METADATA_BYTES);
      // Never let discovery, registration or token exchange cross hosts via redirects.
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        if (soft) return new Response(null, { status: 404 });
        throw new Error('OAuth endpoint ' + new URL(url).origin + ' answered with a redirect; refusing to follow it.');
      }
      const buffer = await readBoundedBody(response, MAX_OAUTH_METADATA_BYTES);
      if (buffer === null) {
        if (soft) return new Response(null, { status: 404 });
        throw new Error('OAuth response exceeded ' + Math.round(MAX_OAUTH_METADATA_BYTES / 1024) + ' KiB.');
      }
      const status = response.status || 502;
      return new Response(NULL_BODY_STATUS.has(status) || !buffer.length ? null : buffer, { status, headers: response.headers });
    } catch (error) {
      if (controller.signal.aborted && !(outer && outer.aborted)) {
        if (soft) return new Response(null, { status: 404 });
        throw new Error('OAuth request timed out.');
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  };
  guarded.safety = safety;
  return guarded;
}

function sameEndpoint(a, b) {
  try {
    const left = new URL(a);
    const right = new URL(b);
    return left.origin === right.origin && left.pathname.replace(/\/$/, '') === right.pathname.replace(/\/$/, '');
  } catch { return false; }
}

// Remote MCP requests carry the server's configured headers (API keys, an
// OAuth bearer token, headersHelper output). fetch's own redirect handling
// drops only Authorization when it crosses origins, so an `X-API-Key` header
// would reach whatever host the server redirects to. Redirects are followed
// here only within the same origin; any other redirect is refused.
const MAX_MCP_REDIRECTS = 5;

export async function fetchMcpSameOrigin(fetchImpl, input, init = {}) {
  let url = String(input instanceof URL ? input.href : (input && input.url) || input);
  const origin = new URL(url).origin;
  let request = { ...init, redirect: 'manual' };
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(url, request);
    if (response.status < 300 || response.status > 399 || response.status === 304) return response;
    const location = response.headers && response.headers.get && response.headers.get('location');
    // An opaque redirect (browser-style manual mode) or one without a Location gives nothing to follow.
    if (!location) return response;
    await response.body?.cancel().catch(() => {});
    const next = new URL(location, url);
    if (next.origin !== origin) throw new Error('MCP server redirected to ' + next.origin + ', a different origin; refusing to send its credentials there.');
    if (hop >= MAX_MCP_REDIRECTS) throw new Error('MCP server redirected too many times.');
    // 303, and 301/302 after POST, turn into GET as fetch would.
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && String(request.method || 'GET').toUpperCase() === 'POST')) {
      const { body: _body, ...rest } = request;
      request = { ...rest, method: 'GET' };
    }
    url = next.href;
  }
}

// One fetch for an SDK transport: requests to the MCP endpoint go to mcpFetch,
// everything else (OAuth discovery, registration, token) to the guarded fetch.
// isMcp is the MCP endpoint URL, or a predicate for transports whose message
// endpoint is announced at runtime (legacy SSE).
export function routeMcpFetch(isMcp, mcpFetch, oauthFetch) {
  const test = typeof isMcp === 'function' ? isMcp : (url) => sameEndpoint(url, isMcp);
  return (input, init) => test(requestUrl(input)) ? mcpFetch(input, init) : oauthFetch(input, init);
}
export { sameEndpoint as sameMcpEndpoint };

function authRequiredError(server) {
  const name = server && server.name || 'server';
  const url = server && server.url ? String(server.url) : '';
  // In a chat the agent can show a Connect card for it (connect_service), then retry.
  const card = url ? ' In a chat, call connect_service with service "' + url + '" so the user can sign in from a Connect card, then retry.' : '';
  const error = new Error('MCP server ' + name + ' needs sign-in. Run oasis mcp login ' + name + ' (or /mcp login ' + name + ' in the terminal).' + card);
  error.code = 'MCP_AUTH_REQUIRED';
  return error;
}
export { authRequiredError };

// Records the scope a server asked for in a 403 insufficient_scope challenge.
export async function rememberRequiredScope(server, scope, env = process.env) {
  if (!scope) return;
  const entry = await getStoredToken(server.url, env).catch(() => null);
  if (entry) await saveStoredToken(server.url, { ...entry, requiredScope: String(scope).slice(0, 1000) }, env).catch(() => {});
}

// ---------- SDK OAuth provider over the OASIS token store ----------

const PLACEHOLDER_REDIRECT = 'http://127.0.0.1/callback';

// Implements the SDK's OAuthClientProvider. Tokens and client registrations live in
// <config>/mcp-auth.json (0600). Without onRedirect (normal connections) the provider
// never opens a browser: when a new authorization would be needed it raises
// MCP_AUTH_REQUIRED, and the user signs in with `oasis mcp login`.
export class OasisOAuthProvider {
  constructor(server, { env = process.env, redirectUrl = null, onRedirect = null, state = null, fresh = false, extraScope = '' } = {}) {
    this.server = server;
    this.env = env;
    this._redirectUrl = redirectUrl;
    this.onRedirect = onRedirect;
    this._state = state;
    this.fresh = fresh;
    this.entry = null;
    this.verifier = '';
    this.authorizationUrl = null;
    const oauth = server.oauth || {};
    this.configuredClient = oauth.clientId
      ? { client_id: String(oauth.clientId), ...(oauth.clientSecret ? { client_secret: String(oauth.clientSecret) } : {}) }
      : null;
    this.configuredScope = Array.isArray(oauth.scopes) ? oauth.scopes.join(' ') : typeof oauth.scopes === 'string' ? oauth.scopes : '';
    this.extraScope = String(extraScope || '').trim();
    // Client ID Metadata Document (SEP-991): an HTTPS URL that serves this client's metadata.
    // Authorization servers that advertise client_id_metadata_document_supported then use it as
    // the client_id instead of dynamic registration. Opt-in: OASIS hosts no such document itself.
    const metadataUrl = oauth.clientMetadataUrl || env.OASIS_MCP_CLIENT_METADATA_URL || '';
    if (metadataUrl && !this.configuredClient) this.clientMetadataUrl = String(metadataUrl);
  }

  async load() {
    if (!this.entry) this.entry = this.fresh ? {} : { ...((await getStoredToken(this.server.url, this.env)) || {}) };
    return this.entry;
  }

  // Saves merge into the entry as it is in the store now, not a copy read
  // earlier: another connection (or OASIS process) may have refreshed the
  // tokens since, and writing an old snapshot back would undo that. A fresh
  // sign-in replaces the entry with what it gathered.
  async _save(patch) {
    await this.load();
    const key = canonicalResource(this.server.url);
    await updateStore(this.env, (store) => {
      const current = this.fresh ? this.entry : (store.servers[key] || {});
      const next = { ...current, ...patch, server: this.server.name, resource: key };
      store.servers[key] = next;
      this.entry = { ...next };
    });
  }

  async _reload() {
    if (this.fresh) return await this.load();
    this.entry = { ...((await getStoredToken(this.server.url, this.env)) || {}) };
    return this.entry;
  }

  get redirectUrl() { return this._redirectUrl || PLACEHOLDER_REDIRECT; }

  get clientMetadata() {
    return {
      client_name: 'Oasis',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      ...(this.configuredScope ? { scope: this.configuredScope } : {})
    };
  }

  state() { return this._state || randomBytes(16).toString('base64url'); }

  async clientInformation() {
    if (this.configuredClient) return this.configuredClient;
    const entry = await this.load();
    if (entry.client && entry.client.client_id) return entry.client;
    if (entry.clientId) return { client_id: entry.clientId, ...(entry.clientSecret ? { client_secret: entry.clientSecret } : {}) };
    return undefined;
  }

  async saveClientInformation(info) {
    await this._save({ client: { ...info }, clientId: info.client_id, clientSecret: info.client_secret || null });
  }

  async tokens() {
    // Read the store each time, so tokens another connection refreshed are used.
    const entry = await this._reload();
    const stored = entry.tokens || {};
    const access = stored.access_token || entry.accessToken;
    if (!access) return undefined;
    this.handedAccessToken = access;
    const out = { access_token: access, token_type: stored.token_type || entry.tokenType || 'Bearer' };
    const refresh = stored.refresh_token || entry.refreshToken;
    if (refresh) out.refresh_token = refresh;
    if (entry.expiresAt) out.expires_in = Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
    const scope = stored.scope || entry.scope;
    if (scope) out.scope = scope;
    // Only the SDK's own issuer stamp binds tokens to an authorization server.
    if (stored.issuer) out.issuer = stored.issuer;
    return out;
  }

  async saveTokens(tokens) {
    const now = Date.now();
    const previous = await this.load();
    const refreshToken = tokens.refresh_token || (previous.tokens && previous.tokens.refresh_token) || previous.refreshToken || null;
    await this._save({
      tokens: { ...tokens, ...(refreshToken ? { refresh_token: refreshToken } : {}) },
      accessToken: tokens.access_token,
      refreshToken,
      tokenType: tokens.token_type || 'Bearer',
      scope: tokens.scope || null,
      expiresAt: tokens.expires_in ? now + Number(tokens.expires_in) * 1000 : null,
      obtainedAt: new Date(now).toISOString(),
      requiredScope: null,
      ...(tokens.issuer ? { issuer: tokens.issuer } : {})
    });
  }

  async redirectToAuthorization(authorizationUrl) {
    // Scopes set explicitly in .mcp.json win over the server-advertised default.
    const url = new URL(String(authorizationUrl));
    if (this.configuredScope) url.searchParams.set('scope', this.configuredScope);
    if (this.extraScope) {
      const scopes = new Set(String(url.searchParams.get('scope') || '').split(/\s+/).filter(Boolean));
      for (const item of this.extraScope.split(/\s+/)) if (item) scopes.add(item);
      url.searchParams.set('scope', [...scopes].join(' '));
    }
    this.authorizationUrl = url.toString();
    if (!this.onRedirect) throw authRequiredError(this.server);
    await this.onRedirect(this.authorizationUrl);
  }

  saveCodeVerifier(verifier) { this.verifier = verifier; }

  codeVerifier() {
    if (!this.verifier) throw new Error('No MCP sign-in is in progress.');
    return this.verifier;
  }

  async invalidateCredentials(scope) {
    const entry = await this.load();
    if (scope === 'verifier') { this.verifier = ''; return; }
    if (scope === 'discovery') return;
    const patch = {};
    let wipeTokens = scope === 'all' || scope === 'tokens';
    // A refresh that failed because another connection already rotated the
    // token must not delete the new tokens that connection saved.
    if (wipeTokens && !this.fresh && this.handedAccessToken) {
      const current = await getStoredToken(this.server.url, this.env).catch(() => null);
      const now = current && ((current.tokens && current.tokens.access_token) || current.accessToken);
      if (now && now !== this.handedAccessToken) wipeTokens = false;
    }
    if (wipeTokens) Object.assign(patch, { tokens: null, accessToken: null, refreshToken: null, expiresAt: null });
    if ((scope === 'all' || scope === 'client') && !this.configuredClient) Object.assign(patch, { client: null, clientId: null, clientSecret: null });
    if (scope === 'all') this.verifier = '';
    if (Object.keys(patch).length && Object.keys(entry).length) await this._save(patch);
  }
}

let sdkModule = null;
export async function loadMcpClientSdk() {
  if (!sdkModule) sdkModule = import('@modelcontextprotocol/client');
  return await sdkModule;
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

function callbackPage(text) {
  return '<!doctype html><title>Oasis</title><body style="font-family:sans-serif;padding:2rem">' + text + '</body>';
}

// Interactive sign-in. print(text) shows the URL; open(url) launches a browser.
// The SDK runs the whole flow (RFC 9728/8414 discovery, CIMD or dynamic client
// registration, PKCE, RFC 8707 resource, RFC 9207 issuer check, scope selection);
// OASIS provides the loopback callback, the token store and the endpoint guard.
// onCallbackReady(deliver) hands out a function that finishes sign-in from a
// pasted redirect address, for when the browser that approved is on another
// device and cannot reach this computer's loopback callback.
export async function loginMcpServer(server, { env = process.env, fetch: fetchImpl = fetch, print = () => {}, open = (url) => openInBrowser(url, { env }), timeoutMs = LOGIN_TIMEOUT_MS, lookupImpl = lookup, scope = '', onCallbackReady = null } = {}) {
  if (!server || server.type !== 'http') throw new Error('Only HTTP MCP servers use sign-in; stdio servers get credentials from environment variables.');
  const oauth = server.oauth || {};
  const oauthFetch = createOAuthFetch(server.url, { fetch: fetchImpl, lookupImpl });
  await requireSafeEndpoint(server.url, 'MCP server URL', oauthFetch.safety);
  const state = randomBytes(16).toString('base64url');
  let finish;
  let fail;
  const result = new Promise((resolve, reject) => { finish = resolve; fail = reject; });
  result.catch(() => {});
  // Only the browser round-trip we started carries our state. Anything else (a
  // stray tab, or another local page poking this port) is answered and ignored.
  const accept = (params) => {
    if (params.get('state') !== state) return 'stale';
    const error = params.get('error');
    if (error) { fail(new Error('The server refused sign-in: ' + error + (params.get('error_description') ? ' - ' + params.get('error_description') : ''))); return 'error'; }
    if (!params.get('code')) return 'error';
    finish(params);
    return 'ok';
  };
  const callback = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname !== '/callback') { res.writeHead(404).end(); return; }
    const outcome = accept(url.searchParams);
    res.writeHead(outcome === 'ok' ? 200 : 400, { 'content-type': 'text/html; charset=utf-8' });
    res.end(callbackPage(outcome === 'stale' ? 'This sign-in link is not the one Oasis is waiting for. Return to Oasis and use the latest link.' : outcome === 'ok' ? 'Signed in to ' + String(server.name).replace(/[<>&]/g, '') + '. You can close this tab and return to Oasis.' : 'Sign-in failed. Return to Oasis and try again.'));
  });
  if (typeof onCallbackReady === 'function') {
    onCallbackReady((address) => {
      let parsed;
      try { parsed = new URL(String(address || '').trim()); } catch { return 'invalid'; }
      if (parsed.pathname !== '/callback') return 'invalid';
      return accept(parsed.searchParams);
    });
  }
  await new Promise((resolve, reject) => { callback.once('error', reject); callback.listen(Number(oauth.callbackPort) || 0, '127.0.0.1', resolve); });
  const timer = setTimeout(() => fail(new Error('Timed out waiting for sign-in in the browser.')), timeoutMs);
  let client = null;
  try {
    const redirectUri = 'http://127.0.0.1:' + callback.address().port + '/callback';
    // A step-up challenge seen at runtime (403 insufficient_scope) is remembered
    // in the store, so a plain `oasis mcp login` asks for the broader scope.
    let previous = null;
    try { previous = await getStoredToken(server.url, env); } catch {}
    const requestedScope = [scope, previous && previous.requiredScope].filter(Boolean).join(' ');
    const provider = new OasisOAuthProvider(server, {
      env, redirectUrl: redirectUri, state, fresh: true, extraScope: requestedScope,
      onRedirect: (url) => {
        print('Sign in to ' + server.name + ' in your browser:\n  ' + url + '\nWaiting for the browser to finish (up to ' + Math.round(timeoutMs / 60000) + ' minutes)...');
        open(url);
      }
    });
    const sdk = await loadMcpClientSdk();
    const mcpFetch = (input, init = {}) => fetchMcpSameOrigin(fetchImpl, input, { ...init, headers: { ...(server.headers || {}), ...plainHeaders(init.headers) } });
    const fetchForSdk = routeMcpFetch(server.url, mcpFetch, oauthFetch);
    // finishAuth must run on the transport that started the flow: it holds the
    // discovery state (resource_metadata hint, issuer) the client was registered with.
    const transport = new sdk.StreamableHTTPClientTransport(new URL(server.url), { authProvider: provider, fetch: fetchForSdk });
    client = new sdk.Client({ name: 'oasis-oss', version: '0' }, { capabilities: {} });
    let connected = false;
    try {
      await client.connect(transport);
      // Some servers allow an anonymous initialize and ask for sign-in on the
      // first real request; listing tools reaches that challenge.
      await client.listTools();
      connected = true;
    } catch (error) {
      if (!provider.authorizationUrl) throw explainLoginError(error);
      const params = await result;
      try { await transport.finishAuth(params); }
      catch (finishError) { throw explainLoginError(finishError); }
    }
    if (connected && !provider.authorizationUrl) {
      const entry = await getStoredToken(server.url, env);
      return { ok: true, server: server.name, scope: entry && entry.scope || null, expiresAt: entry && entry.expiresAt || null, alreadyAuthorized: true };
    }
    const entry = await getStoredToken(server.url, env);
    if (!entry || !entry.accessToken) throw new Error('Sign-in finished but the server issued no access token.');
    return { ok: true, server: server.name, scope: entry.scope || null, expiresAt: entry.expiresAt || null };
  } finally {
    clearTimeout(timer);
    callback.close();
    if (client) await client.close().catch(() => {});
  }
}

function explainLoginError(error) {
  const text = String(error && error.message || error);
  if (/dynamic client registration|registration_endpoint|does not support .*registration/i.test(text)) {
    return new Error('This server does not support automatic client registration. Add "oauth": {"clientId": "..."} to its .mcp.json entry.');
  }
  if (/issuer/i.test(text) && /mismatch|different|expected/i.test(text)) {
    return new Error('Sign-in response came from a different authorization server; refusing it. (' + text.slice(0, 300) + ')');
  }
  return error instanceof Error ? error : new Error(text);
}

// Refreshes a stored token that expires within a minute, before it is used.
// The SDK refreshes after a 401 on its own; this keeps the first request clean.
export async function refreshExpiringToken(server, { env = process.env, fetch: fetchImpl = fetch, lookupImpl = lookup } = {}) {
  let entry;
  try { entry = await getStoredToken(server.url, env); } catch { return false; }
  const refreshToken = entry && (entry.refreshToken || (entry.tokens && entry.tokens.refresh_token));
  if (!refreshToken || !entry.expiresAt || entry.expiresAt - Date.now() >= 60000) return false;
  const provider = new OasisOAuthProvider(server, { env });
  const { auth } = await loadMcpClientSdk();
  try {
    return (await auth(provider, { serverUrl: server.url, fetchFn: createOAuthFetch(server.url, { fetch: fetchImpl, lookupImpl }) })) === 'AUTHORIZED';
  } catch { return false; }
}
