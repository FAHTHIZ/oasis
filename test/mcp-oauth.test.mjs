import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { connectMcpServers, closeMcpClients } from '../src/mcp.mjs';
import { loadProjectMcpServers } from '../src/mcp-project.mjs';
import { getStoredToken, saveStoredToken, discoverOAuth, openInBrowser, createOAuthFetch } from '../src/mcp-oauth.mjs';
import { fetchMcpSameOrigin, OasisOAuthProvider } from '../src/mcp-oauth.mjs';
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
async function fakeServer(t, { expiresIn = 3600, urlHost = '127.0.0.1', iss, issSupported = false } = {}) {
  const state = { codes: new Map(), tokens: new Set(), refreshes: 0, registered: [], authorizeParams: null, tokenRequests: [] };
  let base;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, base);
    let body = '';
    for await (const chunk of req) body += chunk;
    const json = (status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(value)); };
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') return json(200, { resource: base + '/mcp', authorization_servers: [base], scopes_supported: ['tools.read'] });
    if (url.pathname === '/.well-known/oauth-authorization-server') return json(200, { issuer: base, response_types_supported: ['code'], authorization_endpoint: base + '/authorize', token_endpoint: base + '/token', registration_endpoint: base + '/register', code_challenge_methods_supported: ['S256'], ...(issSupported ? { authorization_response_iss_parameter_supported: true } : {}) });
    if (url.pathname === '/register') { const reg = JSON.parse(body); state.registered.push(reg); return json(201, { client_id: 'client-' + state.registered.length, redirect_uris: reg.redirect_uris }); }
    if (url.pathname === '/authorize') {
      state.authorizeParams = Object.fromEntries(url.searchParams);
      const code = 'code-' + Math.random().toString(36).slice(2);
      state.codes.set(code, url.searchParams.get('code_challenge'));
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state'));
      if (iss !== undefined) back.searchParams.set('iss', iss === true ? base : iss);
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
      if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
      const message = JSON.parse(body);
      if (message.id === undefined) { res.writeHead(202); return res.end(); }
      const result = message.method === 'initialize' ? { protocolVersion: '2025-03-26', serverInfo: { name: 'test', version: '1' }, capabilities: { tools: {} } }
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

test('discovery through protected-resource metadata', async (t) => {
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
    response_types_supported: ['code'],
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
        // Endless: only a reader that stops at its byte limit gets past this.
        start(controller) { controller.enqueue(new TextEncoder().encode('{"metadata":"')); },
        pull(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(64 * 1024))); },
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
  assert.equal(largeBodyRead, true, 'the oversized body is cancelled, not buffered');
});

test('OAuth discovery bounds time spent waiting for stalled metadata endpoints', async () => {
  const requests = [];
  const fetchImpl = (url, init = {}) => new Promise((_resolve, reject) => {
    requests.push({ url: String(url), init });
    const fail = () => reject(init.signal.reason || new Error('request aborted'));
    if (!init.signal || init.signal.aborted) { fail(); return; }
    init.signal.addEventListener('abort', fail, { once: true });
  });
  const started = Date.now();
  const found = await discoverOAuth('https://mcp.example/mcp', {
    fetch: fetchImpl,
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchTimeoutMs: 20
  });
  assert.ok(Date.now() - started < 1000, 'discovery should return promptly when metadata endpoints stall');
  assert.equal(found.issuer, 'https://mcp.example');
  assert.ok(requests.length >= 3, 'the probe and metadata candidates should each be attempted');
  assert.ok(requests.every((request) => request.init.signal instanceof AbortSignal), 'every request must have an abort signal');
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
        response_types_supported: ['code'],
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
  await assert.rejects(mcpLogin(root, 'nope', { env }), /No HTTP or SSE MCP server named nope/);
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

test('RFC 9207: sign-in checks the iss parameter against the discovered issuer', async (t) => {
  {
    const { base } = await fakeServer(t, { iss: true, issSupported: true });
    const { root, env } = await workspace(t, base);
    assert.match(await mcpLogin(root, 'remote', { env, print: () => {}, open: browser }), /Signed in to remote/);
  }
  {
    const { base } = await fakeServer(t, { iss: 'https://evil.example' });
    const { root, env } = await workspace(t, base);
    await assert.rejects(mcpLogin(root, 'remote', { env, print: () => {}, open: browser, timeoutMs: 5000 }), /different authorization server/);
  }
  {
    const { base } = await fakeServer(t, { issSupported: true });
    const { root, env } = await workspace(t, base);
    await assert.rejects(mcpLogin(root, 'remote', { env, print: () => {}, open: browser, timeoutMs: 5000 }), /different authorization server/);
  }
});

test('a stray callback with the wrong state or a forged error does not end sign-in', async (t) => {
  const { base } = await fakeServer(t);
  const { root, env } = await workspace(t, base);
  const strays = [];
  const open = (url) => {
    const redirect = new URL(new URL(url).searchParams.get('redirect_uri'));
    // Another local page pokes the callback first; the real browser round-trip follows.
    (async () => {
      for (const query of ['?state=wrong&code=evil', '?error=access_denied', '?code=nostate']) {
        const response = await fetch(redirect.toString() + query).catch(() => null);
        strays.push(response && response.status);
      }
      await fetch(url, { redirect: 'follow' }).catch(() => {});
    })();
    return true;
  };
  await mcpLogin(root, 'remote', { env, open });
  assert.deepEqual(strays, [400, 400, 400]);
  assert.ok(await getStoredToken(base + '/mcp', env));
});

test('OAuth metadata on another loopback port needs OASIS_MCP_OAUTH_ALLOW_LOOPBACK=1', async (t) => {
  const previous = process.env.OASIS_MCP_OAUTH_ALLOW_LOOPBACK;
  t.after(() => { if (previous === undefined) delete process.env.OASIS_MCP_OAUTH_ALLOW_LOOPBACK; else process.env.OASIS_MCP_OAUTH_ALLOW_LOOPBACK = previous; });
  const seen = [];
  const fetchImpl = async (url) => { seen.push(String(url)); return new Response('{}', { headers: { 'content-type': 'application/json' } }); };
  const metadata = 'http://127.0.0.1:9/.well-known/oauth-authorization-server';
  delete process.env.OASIS_MCP_OAUTH_ALLOW_LOOPBACK;
  const blocked = await createOAuthFetch('http://127.0.0.1:8/mcp', { fetch: fetchImpl })(metadata);
  assert.equal(blocked.status, 404);
  assert.deepEqual(seen, []);
  process.env.OASIS_MCP_OAUTH_ALLOW_LOOPBACK = '1';
  const allowed = await createOAuthFetch('http://127.0.0.1:8/mcp', { fetch: fetchImpl })(metadata);
  assert.equal(allowed.status, 200);
  assert.deepEqual(seen, [metadata]);
  const publicHttp = await createOAuthFetch('http://127.0.0.1:8/mcp', { fetch: fetchImpl })('http://auth.example/token');
  assert.equal(publicHttp.status, 404, 'the opt-in never allows plain HTTP to non-loopback hosts');
});

test('MCP requests follow same-origin redirects but never send headers to another origin', async (t) => {
  // Regression: an MCP server answering 307 to another host received the
  // configured X-API-Key header there (fetch strips only Authorization).
  const seen = [];
  const other = createServer((req, res) => { seen.push(['other', req.headers['x-api-key']]); res.end('{}'); });
  const main = createServer((req, res) => {
    seen.push(['main', req.url, req.headers['x-api-key']]);
    if (req.url === '/old') { res.writeHead(308, { location: '/mcp' }); res.end(); return; }
    if (req.url === '/away') { res.writeHead(307, { location: 'http://127.0.0.1:' + other.address().port + '/mcp' }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}');
  });
  await Promise.all([new Promise((r) => main.listen(0, '127.0.0.1', r)), new Promise((r) => other.listen(0, '127.0.0.1', r))]);
  t.after(() => { main.close(); other.close(); });
  const base = 'http://127.0.0.1:' + main.address().port;
  const init = { method: 'POST', headers: { 'x-api-key': 'k1', 'content-type': 'application/json' }, body: '{}' };
  const ok = await fetchMcpSameOrigin(fetch, base + '/old', init);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true });
  await assert.rejects(fetchMcpSameOrigin(fetch, base + '/away', init), /different origin/);
  assert.equal(seen.some(([where]) => where === 'other'), false, 'the other origin was contacted');
});

test('concurrent refreshes share one token request, survive cancellation and keep rotated tokens', async (t) => {
  // Regression (Codex 0.167.2 class): concurrent 401s each refreshed with the
  // same rotating refresh token, the losers wiped the winner's new tokens, and
  // a cancelled request could abort the rotation and lose the new token.
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-oauth-refresh-race-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: home };
  let grants = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      grants++;
      setTimeout(() => {
        res.writeHead(body.includes('refresh_token=R1') && grants === 1 ? 200 : 400, { 'content-type': 'application/json' });
        res.end(grants === 1 ? '{"access_token":"A2","refresh_token":"R2","token_type":"Bearer"}' : '{"error":"invalid_grant"}');
      }, 80);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = 'http://127.0.0.1:' + server.address().port;
  const oauthFetch = createOAuthFetch(base + '/mcp', { fetch: (url, init) => fetch(url, init) });
  const body = () => new URLSearchParams({ grant_type: 'refresh_token', refresh_token: 'R1', client_id: 'c' });
  const cancelled = new AbortController();
  const calls = [1, 2, 3].map((n) => oauthFetch(base + '/token', { method: 'POST', body: body(), ...(n === 3 ? { signal: cancelled.signal } : {}) }));
  setTimeout(() => cancelled.abort(new Error('request cancelled')), 20);
  const responses = await Promise.all(calls);
  assert.equal(grants, 1, 'one refresh grant reached the server');
  for (const response of responses) assert.deepEqual([response.status, (await response.json()).access_token], [200, 'A2']);

  // A provider that handed out A1 and then sees a failed refresh must not wipe
  // the A2 that another connection saved in the meantime.
  const config = { name: 'remote', url: base + '/mcp' };
  await saveStoredToken(config.url, { tokens: { access_token: 'A1', refresh_token: 'R1' }, accessToken: 'A1', refreshToken: 'R1', clientId: 'c' }, env);
  const stale = new OasisOAuthProvider(config, { env });
  assert.equal((await stale.tokens()).access_token, 'A1');
  const other = new OasisOAuthProvider(config, { env });
  await other.saveTokens({ access_token: 'A2', refresh_token: 'R2', token_type: 'Bearer' });
  await stale.invalidateCredentials('tokens');
  let saved = await getStoredToken(config.url, env);
  assert.equal(saved.accessToken, 'A2');
  assert.equal(saved.clientId, 'c', 'saving tokens kept the client registration');
  assert.equal((await stale.tokens()).access_token, 'A2', 'the stale connection picks up the refreshed token');
  // When nothing newer exists, invalidation still clears the bad tokens.
  await stale.invalidateCredentials('tokens');
  saved = await getStoredToken(config.url, env);
  assert.equal(saved.accessToken, null);
});
