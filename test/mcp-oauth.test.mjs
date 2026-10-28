import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { connectMcpServers, closeMcpClients } from '../src/mcp.mjs';
import { loadProjectMcpServers } from '../src/mcp-project.mjs';
import { getStoredToken, parseWwwAuthenticate, discoverOAuth } from '../src/mcp-oauth.mjs';
import { mcpLogin, mcpLogout } from '../src/mcp-auth-commands.mjs';

// A fake MCP server that is also its own OAuth authorization server.
async function fakeServer(t, { expiresIn = 3600 } = {}) {
  const state = { codes: new Map(), tokens: new Set(), refreshes: 0, registered: [], authorizeParams: null, tokenRequests: [] };
  let base;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') return json(200, { resource: base + '/mcp', authorization_servers: [base], scopes_supported: ['tools.read'] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', code_challenge_methods_supported: ['S256'] });
    if (url.pathname === '/register') { const reg = JSON.parse(body); state.registered.push(reg); return json(201, { client_id: 'client-' + state.registered.length, redirect_uris: reg.redirect_uris }); }
    if (url.pathname === '/authorize') {
      state.authorizeParams = Object.fromEntries(url.searchParams);
      const code = 'code-' + Math.random().toString(36).slice(2);
      state.codes.set(code, url.searchParams.get('code_challenge'));
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (url.pathname === '/token') {
      const form = Object.fromEntries(new URLSearchParams(body));
      state.tokenRequests.push(form);
      if (form.grant_type === 'authorization_code') {
        const challenge = state.codes.get(form.code);
        const expected = createHash('sha256').update(form.code_verifier || '').digest('base64url');
        if (!challenge || challenge !== expected) return json(400, { error: 'invalid_grant' });
        state.codes.delete(form.code);
      } else if (form.grant_type === 'refresh_token') {
        if (form.refresh_token !== 'refresh-1') return json(400, { error: 'invalid_grant' });
        state.refreshes += 1;
      }
      const token = 'access-' + (state.tokens.size + 1);
      state.tokens.add(token);
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: expiresIn, refresh_token: 'refresh-1', scope: 'tools.read' });
    }
    if (url.pathname === '/mcp') {
      const auth = String(req.headers.authorization || '').replace(/^Bearer /, '');
      if (!state.tokens.has(auth) || state.revoked === auth) return json(401, { error: 'unauthorized' }, { 'www-authenticate': 'Bearer resource_metadata="' + base + '/.well-known/oauth-protected-resource/mcp"' });
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', capabilities: { tools: {} } }
        : message.method === 'tools/list' ? { tools: [{ name: 'secret_data', inputSchema: { type: 'object' } }] } : {};
      return json(200, { jsonrpc: '2.0', id: message.id, result });
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + server.address().port;
  t.after(() => server.close());
  return { base, state };
}

async function workspace(t, base, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-oauth-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-oauth-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { remote: { type: 'http', url: base + '/mcp', ...extra } } }));
  return { root, env: { ...process.env, OASIS_CONFIG_DIR: home, HOME: home, OASIS_NO_BROWSER: '1' } };
}

// Plays the browser: follow the authorization redirect back to the loopback callback.
const browser = (url) => { fetch(url, { redirect: 'follow' }).catch(() => {}); return true; };

test('WWW-Authenticate parsing and discovery through protected-resource metadata', async (t) => {
  assert.deepEqual(parseWwwAuthenticate('Bearer realm="x", resource_metadata="https://a/b"'), { realm: 'x', resource_metadata: 'https://a/b' });
  const { base } = await fakeServer(t);
  const found = await discoverOAuth(base + '/mcp');
  assert.equal(found.tokenEndpoint, base + '/token');
  assert.equal(found.registrationEndpoint, base + '/register');
  assert.deepEqual(found.scopes, ['tools.read']);
});

test('OAuth discovery rejects redirects instead of following them', async () => {
  const serverUrl = 'https://mcp.example/mcp';
  const metadataUrl = 'https://metadata.example/protected-resource';
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), redirect: init.redirect, signal: init.signal });
    if (init.method === 'POST') {
      return new Response('', {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` }
      });
    }
    return new Response('redirect body', {
      status: 302,
      headers: { location: 'http://127.0.0.1:1234/private' }
    });
  };

  const found = await discoverOAuth(serverUrl, { fetch: fetchImpl, fetchTimeoutMs: 20 });
  assert.ok(calls.length > 1);
  assert.ok(calls.every((call) => call.redirect === 'error'), 'every fetch must disable automatic redirects');
  assert.ok(calls.every((call) => call.signal instanceof AbortSignal), 'every fetch must have a timeout signal');
  assert.equal(calls.some((call) => call.url.startsWith('http://127.0.0.1:1234/')), false, 'redirect targets must never be fetched automatically');
  assert.equal(found.issuer, 'https://mcp.example');
});

test('OAuth discovery ignores oversized metadata without a Content-Length header', async () => {
  const serverUrl = 'https://mcp.example/mcp';
  const metadataUrl = 'https://metadata.example/protected-resource';
  const oversized = JSON.stringify({
    resource: serverUrl,
    authorization_servers: ['https://attacker.example'],
    scopes_supported: ['tools.read']
  }) + ' '.repeat(256 * 1024 + 32);
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    if (init.method === 'POST') {
      return new Response('', {
        status: 401,
        headers: { 'www-authenticate': `Bearer resource_metadata="${metadataUrl}"` }
      });
    }
    if (target === metadataUrl) {
      return new Response(oversized, { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (target === 'https://mcp.example/.well-known/oauth-authorization-server') {
      return new Response(JSON.stringify({
        issuer: 'https://mcp.example',
        authorization_endpoint: 'https://mcp.example/authorize',
        token_endpoint: 'https://mcp.example/token',
        registration_endpoint: 'https://mcp.example/register'
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('', { status: 404 });
  };

  const found = await discoverOAuth(serverUrl, { fetch: fetchImpl });
  assert.equal(calls.includes(metadataUrl), true);
  assert.equal(found.issuer, 'https://mcp.example', 'oversized untrusted metadata must not select an issuer');
  assert.equal(found.authorizationEndpoint, 'https://mcp.example/authorize');
});

test('OAuth discovery bounds time spent waiting for stalled metadata endpoints', async () => {
  const fetchImpl = (_url, init = {}) => new Promise((_resolve, reject) => {
    const fail = () => reject(init.signal.reason || new Error('request aborted'));
    if (init.signal.aborted) { fail(); return; }
    init.signal.addEventListener('abort', fail, { once: true });
  });
  const started = Date.now();
  const found = await discoverOAuth('https://mcp.example/mcp', { fetch: fetchImpl, fetchTimeoutMs: 20 });
  assert.ok(Date.now() - started < 1000, 'discovery should return promptly when each request times out');
  assert.equal(found.issuer, 'https://mcp.example');
});

test('a server that needs sign-in fails with clear advice, then works after oasis mcp login', async (t) => {
  const { base, state } = await fakeServer(t);
  const { root, env } = await workspace(t, base);
  const project = await loadProjectMcpServers(root, { env });
  const before = await connectMcpServers({ env, extraServers: project.servers });
  assert.match(before.failures[0].error, /needs sign-in\. Run oasis mcp login remote/);

  const printed = [];
  const message = await mcpLogin(root, 'remote', { env, print: (text) => printed.push(text), open: browser });
  assert.match(message, /Signed in to remote \(scope: tools\.read\)/);
  assert.match(printed[0], /Sign in to remote in your browser/);
  assert.equal(state.authorizeParams.code_challenge_method, 'S256');
  assert.equal(state.authorizeParams.resource, base + '/mcp');
  assert.equal(state.authorizeParams.scope, 'tools.read');
  assert.match(state.registered[0].redirect_uris[0], /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  assert.equal(state.registered[0].token_endpoint_auth_method, 'none');

  const stored = await getStoredToken(base + '/mcp', env);
  assert.equal(stored.accessToken, 'access-1');
  assert.equal((await stat(path.join(env.OASIS_CONFIG_DIR, 'mcp-auth.json'))).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(path.join(root, '.mcp.json'), 'utf8'), /access-/);

  const after = await connectMcpServers({ env, extraServers: project.servers });
  t.after(() => closeMcpClients(after.clients));
  assert.equal(after.failures.length, 0);
  assert.equal(after.clients.get('remote').tools[0].name, 'secret_data');

  assert.match(await mcpLogout(root, 'remote', { env }), /Signed out/);
  assert.equal(await getStoredToken(base + '/mcp', env), null);
});

test('expired or rejected tokens are refreshed automatically', async (t) => {
  const { base, state } = await fakeServer(t, { expiresIn: 30 });
  const { root, env } = await workspace(t, base, { oauth: { clientId: 'preregistered', scopes: ['a', 'b'] } });
  await mcpLogin(root, 'remote', { env, open: browser });
  assert.equal(state.registered.length, 0, 'a configured clientId skips registration');
  assert.equal(state.authorizeParams.client_id, 'preregistered');
  assert.equal(state.authorizeParams.scope, 'a b');
  const project = await loadProjectMcpServers(root, { env });
  const connected = await connectMcpServers({ env, extraServers: project.servers });
  t.after(() => closeMcpClients(connected.clients));
  assert.equal(connected.failures.length, 0);
  assert.ok(state.refreshes >= 1, 'a token expiring within a minute is refreshed before use');
  state.revoked = (await getStoredToken(base + '/mcp', env)).accessToken;
  const before = state.refreshes;
  await connected.clients.get('remote')._request('tools/list', {});
  assert.equal(state.refreshes, before + 1, 'a 401 triggers one refresh and a retry');
});

test('login rejects stdio servers and unknown names', async (t) => {
  const { root, env } = await workspace(t, 'http://127.0.0.1:9');
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: 'node' } } }));
  await assert.rejects(mcpLogin(root, 'local', { env }), /stdio server/);
  await assert.rejects(mcpLogin(root, 'nope', { env }), /No HTTP MCP server named nope/);
});

test('signing in from a running session connects the server right away', async (t) => {
  const { base } = await fakeServer(t);
  const { root, env } = await workspace(t, base);
  const session = { mcpClients: new Map(), mcpToolMap: new Map(), mcpFailures: [{ name: 'remote', error: 'needs sign-in' }], toolDefinitions: [{ type: 'function', function: { name: 'read_file' } }] };
  t.after(() => closeMcpClients(session.mcpClients));
  const message = await mcpLogin(root, 'remote', { env, open: browser, session });
  assert.match(message, /Connected: 1 tool\(s\)/);
  assert.deepEqual(session.toolDefinitions.map((tool) => tool.function.name), ['read_file', 'mcp_remote_secret_data']);
  assert.equal(session.mcpFailures.length, 0);
});
