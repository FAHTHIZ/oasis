import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { connectMcpServers, closeMcpClients } from '../src/mcp.mjs';
import { loadProjectMcpServers } from '../src/mcp-project.mjs';
import { getStoredToken, saveStoredToken, parseWwwAuthenticate, discoverOAuth, openInBrowser } from '../src/mcp-oauth.mjs';
import { mcpLogin, mcpLogout } from '../src/mcp-auth-commands.mjs';

test('OAuth token storage preserves concurrent server updates', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-oauth-store-race-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: home };
  const count = 16;
  await Promise.all(Array.from({ length: count }, (_, index) =>
    saveStoredToken('https://mcp-' + index + '.example/mcp', {
      accessToken: 'access-' + index,
      refreshToken: 'refresh-' + index
    }, env)
  ));

  const saved = JSON.parse(await readFile(path.join(home, 'mcp-auth.json'), 'utf8'));
  assert.equal(Object.keys(saved.servers).length, count);
  for (let index = 0; index < count; index++) {
    assert.equal(saved.servers['https://mcp-' + index + '.example/mcp'].accessToken, 'access-' + index);
  }
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(home, 'mcp-auth.json'))).mode & 0o777, 0o600);
  }
});

test('OAuth token storage refuses to overwrite a corrupted store', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-oauth-store-corrupt-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: home };
  const file = path.join(home, 'mcp-auth.json');
  const malformed = '{"servers":';
  await writeFile(file, malformed, 'utf8');

  await assert.rejects(
    saveStoredToken('https://mcp.example/mcp', { accessToken: 'new-token' }, env),
    /invalid JSON.*preserving the existing file/
  );
  assert.equal(await readFile(file, 'utf8'), malformed, 'corrupt token data must not be silently replaced');
});

test('Windows OAuth browser launch passes URL as an argument without cmd.exe', () => {
  const url = 'https://login.example.test/authorize?client_id=demo&redirect_uri=http%3A%2F%2F127.0.0.1%3A1234%2Fcallback&state=x';
  let invocation = null;
  const result = openInBrowser(url, {
    platform: 'win32',
    env: {},
    spawnImpl: (command, args, options) => {
      invocation = { command, args, options };
      return { on() { return this; }, unref() {} };
    }
  });
  assert.equal(result, true);
  assert.equal(invocation.command, 'explorer.exe');
  assert.deepEqual(invocation.args, [url]);
  assert.equal(invocation.options.shell, false);
});

// A fake MCP server that is also its own OAuth authorization server.
async function fakeServer(t, { expiresIn = 3600, urlHost = '127.0.0.1' } = {}) {
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
  base = 'http://' + urlHost + ':' + server.address().port;
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

test('OAuth loopback hostnames are pinned to an explicit loopback address', async (t) => {
  const { base } = await fakeServer(t, { urlHost: 'localhost' });
  const found = await discoverOAuth(base + '/mcp');
  assert.equal(found.tokenEndpoint, base + '/token');
  assert.equal(found.registrationEndpoint, base + '/register');
});

test('OAuth discovery refuses redirects and bounds metadata bodies', async () => {
  const origin = 'https://mcp.example';
  const requests = [];
  const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];
  const authorizationMetadata = {
    issuer: origin,
    authorization_endpoint: origin + '/authorize',
    token_endpoint: origin + '/token',
    registration_endpoint: origin + '/register',
    code_challenge_methods_supported: ['S256']
  };
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    if (url === origin + '/mcp') {
      return new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="' + origin + '/meta"' }
      });
    }
    if (url === origin + '/meta') {
      return new Response(null, { status: 302, headers: { location: 'https://attacker.example/metadata' } });
    }
    if (url === origin + '/.well-known/oauth-authorization-server') {
      return new Response(JSON.stringify(authorizationMetadata), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(null, { status: 404 });
  };

  const found = await discoverOAuth(origin + '/mcp', { fetch: fetchImpl, lookupImpl: publicLookup });
  assert.equal(found.tokenEndpoint, origin + '/token');
  assert.equal(requests.some((request) => request.url.startsWith('https://attacker.example/')), false);
  assert.equal(requests.find((request) => request.url === origin + '/mcp').options.redirect, 'manual');
  assert.equal(requests.find((request) => request.url === origin + '/meta').options.redirect, 'manual');
  assert.ok(requests.find((request) => request.url === origin + '/meta').options.signal instanceof AbortSignal);

  let largeBodyRead = false;
  const oversizedFetch = async (url) => {
    if (url === origin + '/large') {
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"metadata":"' + 'x'.repeat(270 * 1024) + '"}'));
          controller.close();
        },
        cancel() { largeBodyRead = true; }
      });
      return new Response(body, { headers: { 'content-type': 'application/json' } });
    }
    if (url === origin + '/.well-known/oauth-authorization-server') {
      return new Response(JSON.stringify(authorizationMetadata), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(null, { status: 404 });
  };
  const large = await discoverOAuth(origin + '/mcp', { fetch: oversizedFetch, resourceMetadataUrl: origin + '/large', lookupImpl: publicLookup });
  assert.equal(large.tokenEndpoint, origin + '/token');
  assert.equal(large.scopes, null, 'oversized resource metadata is ignored');
});

test('OAuth discovery never fetches private-network resource metadata URLs', async () => {
  const origin = 'https://mcp.example';
  const requests = [];
  const lookupImpl = async () => [{ address: '93.184.216.34', family: 4 }];
  const fetchImpl = async (url) => {
    requests.push(String(url));
    if (url === origin + '/mcp') {
      return new Response(null, {
        status: 401,
        headers: { 'www-authenticate': 'Bearer resource_metadata="http://169.254.169.254/latest/meta-data"' }
      });
    }
    if (url === origin + '/.well-known/oauth-authorization-server') {
      return new Response(JSON.stringify({
        issuer: origin,
        authorization_endpoint: origin + '/authorize',
        token_endpoint: origin + '/token'
      }), { headers: { 'content-type': 'application/json' } });
    }
    return new Response(null, { status: 404 });
  };
  const found = await discoverOAuth(origin + '/mcp', { fetch: fetchImpl, lookupImpl });
  assert.equal(found.tokenEndpoint, origin + '/token');
  assert.equal(requests.some((url) => url.includes('169.254.169.254')), false);
  await assert.rejects(
    discoverOAuth(origin + '/mcp', { fetch: fetchImpl, lookupImpl: async () => [{ address: '0:0:0:0:0:ffff:7f00:1', family: 6 }] }),
    /resolves to a private or special-purpose address/
  );
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
