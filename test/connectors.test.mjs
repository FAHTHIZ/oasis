import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { findCatalogConnector, resolveConnector, connectorStatus, createConnectFlow, runConnectService, parseGhDevicePrompt, terminalCardLines, connectInTerminal, CONNECT_SERVICE_TOOL_DEFINITION } from '../src/connectors.mjs';
import { getStoredToken, saveStoredToken } from '../src/mcp-oauth.mjs';

async function sandbox(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-connectors-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'project');
  await mkdir(root, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home, USERPROFILE: home, OASIS_CONFIG_DIR: path.join(home, 'config'), OASIS_NO_BROWSER: '1' };
  return { home, root, env };
}

// A child process stand-in for `gh`.
function fakeGh(handlers) {
  const calls = [];
  const spawn = (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; child.emit('close', null); };
    setImmediate(() => (handlers[args.slice(0, 2).join(' ')] || ((c) => c.emit('close', 1)))(child));
    return child;
  };
  return { spawn, calls };
}

const githubUser = (login = 'octo') => async (url) => {
  assert.equal(String(url), 'https://api.github.com/user');
  return new Response(JSON.stringify({ login }), { status: 200, headers: { 'x-oauth-scopes': 'repo, read:org' } });
};

const fakeSession = (root) => ({ root, mcpClients: new Map(), toolDefinitions: [] });
const fakeReconnect = (tools = ['list_issues', 'create_issue']) => async (session, config) => {
  const client = { config, tools: tools.map((name) => ({ name })) };
  session.mcpClients.set(config.name, client);
  return client;
};

test('catalog finds services by name, alias and URL', () => {
  assert.equal(findCatalogConnector('GitHub').id, 'github');
  assert.equal(findCatalogConnector('connect my github account').id, 'github');
  assert.equal(findCatalogConnector('jira').id, 'atlassian');
  assert.equal(findCatalogConnector('Hugging Face').id, 'huggingface');
  assert.equal(findCatalogConnector('https://mcp.linear.app/mcp').id, 'linear');
  assert.equal(findCatalogConnector('something-unknown'), null);
  assert.equal(CONNECT_SERVICE_TOOL_DEFINITION.function.name, 'connect_service');
});

test('resolveConnector accepts a pasted https MCP URL', async () => {
  const connector = await resolveConnector('https://mcp.example.com/mcp');
  assert.equal(connector.source, 'url');
  assert.equal(connector.url, 'https://mcp.example.com/mcp');
  assert.equal(connector.auth, 'oauth');
});

test('resolveConnector falls back to remote servers in the MCP Registry', async () => {
  const fetchImpl = async (url) => {
    const text = String(url);
    if (text.includes('/v0.1/servers?')) return new Response(JSON.stringify({ servers: [{ server: { name: 'com.acme/tracker', title: 'Acme Tracker', description: 'Tickets', remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp' }] } }] }), { status: 200 });
    if (text.includes('/versions/latest')) return new Response(JSON.stringify({ server: { name: 'com.acme/tracker', remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.dev/mcp' }] } }), { status: 200 });
    return new Response('{}', { status: 404 });
  };
  const connector = await resolveConnector('acme', { fetchImpl, env: {} });
  assert.equal(connector.source, 'registry');
  assert.equal(connector.url, 'https://mcp.acme.dev/mcp');
  await assert.rejects(resolveConnector('nothing-here', { fetchImpl: async () => new Response(JSON.stringify({ servers: [] }), { status: 200 }), env: {} }), /No connector found/);
});

test('OAuth connector: Connect writes mcp.json, signs in and attaches tools to the chat', async (t) => {
  const { root, env } = await sandbox(t);
  const session = fakeSession(root);
  const connector = findCatalogConnector('linear');
  const updates = [];
  let opened = '';
  const flow = createConnectFlow(connector, {
    root, env, session, onUpdate: (view) => updates.push(view.status),
    deps: {
      reconnectMcpServer: fakeReconnect(),
      openBrowser: (url) => { opened = url; },
      loginMcpServer: async (server, options) => {
        assert.equal(server.url, 'https://mcp.linear.app/mcp');
        assert.equal(typeof options.onCallbackReady, 'function');
        options.open('https://linear.app/oauth/authorize?state=x');
        await saveStoredToken(server.url, { accessToken: 'tok', server: server.name }, options.env);
        return { ok: true };
      }
    }
  });
  assert.equal(flow.view().status, 'ready');
  flow.connect();
  const final = await flow.done;
  assert.equal(final.status, 'connected', final.message);
  assert.deepEqual(final.tools, ['list_issues', 'create_issue']);
  assert.ok(updates.includes('authorize'));
  assert.equal(opened, 'https://linear.app/oauth/authorize?state=x');
  const saved = JSON.parse(await readFile(path.join(env.OASIS_CONFIG_DIR, 'mcp.json'), 'utf8'));
  assert.deepEqual(saved.mcpServers.linear, { type: 'http', url: 'https://mcp.linear.app/mcp' });
  const status = await connectorStatus(connector, { root, env, session });
  assert.equal(status.signedIn, true);
  assert.ok(status.live);
});

test('GitHub connector uses an existing gh sign-in at once and stores the token for the MCP server', async (t) => {
  const { root, env } = await sandbox(t);
  const session = fakeSession(root);
  const gh = fakeGh({ 'auth token': (child) => { child.stdout.emit('data', 'gho_' + 'a'.repeat(36) + '\n'); child.emit('close', 0); } });
  const flow = createConnectFlow(findCatalogConnector('github'), { root, env, session, deps: { ghAvailable: true, spawn: gh.spawn, fetch: githubUser('octo'), reconnectMcpServer: fakeReconnect(['get_me']) } });
  flow.connect();
  const final = await flow.done;
  assert.equal(final.status, 'connected', final.message);
  assert.equal(final.account, '@octo');
  assert.match(final.message, /GitHub is connected as @octo/);
  const stored = await getStoredToken('https://api.githubcopilot.com/mcp/', env);
  assert.equal(stored.accessToken, 'gho_' + 'a'.repeat(36));
  assert.equal(gh.calls.length, 1);
});

test('GitHub connector runs gh device sign-in and shows the one-time code', async (t) => {
  const { root, env } = await sandbox(t);
  let signedIn = false;
  const gh = fakeGh({
    'auth token': (child) => { if (signedIn) child.stdout.emit('data', 'gho_' + 'b'.repeat(36)); child.emit('close', signedIn ? 0 : 1); },
    'auth login': (child) => {
      child.stderr.emit('data', '! First copy your one-time code: AB12-CD34\nOpen this URL to continue in your web browser: https://github.com/login/device\n');
      setTimeout(() => { signedIn = true; child.emit('close', 0); }, 20);
    }
  });
  const seen = [];
  const flow = createConnectFlow(findCatalogConnector('github'), { root, env, session: fakeSession(root), onUpdate: (view) => { if (view.code) seen.push(view.code); }, deps: { ghAvailable: true, spawn: gh.spawn, fetch: githubUser(), reconnectMcpServer: fakeReconnect() } });
  flow.connect();
  const final = await flow.done;
  assert.equal(final.status, 'connected', final.message);
  assert.ok(seen.includes('AB12-CD34'));
  assert.ok(gh.calls.some((call) => call.includes('login') && call.includes('--web')));
});

test('GitHub connector without gh asks for a token on the card', async (t) => {
  const { root, env } = await sandbox(t);
  const flow = createConnectFlow(findCatalogConnector('github'), { root, env, session: fakeSession(root), deps: { ghAvailable: false, fetch: githubUser('me'), reconnectMcpServer: fakeReconnect() } });
  const waiting = new Promise((resolve) => flow.subscribe((view) => { if (view.status === 'token') resolve(view); }));
  flow.connect();
  const view = await waiting;
  assert.match(view.url, /^https:\/\/github\.com\/settings\/tokens\/new/);
  assert.throws(() => flow.submitToken('nope'), /does not look like/);
  flow.submitToken('ghp_' + 'c'.repeat(36));
  const final = await flow.done;
  assert.equal(final.status, 'connected');
  assert.equal(final.account, '@me');
});

test('Not now settles the card as skipped; failures carry the reason', async (t) => {
  const { root, env } = await sandbox(t);
  const skipped = createConnectFlow(findCatalogConnector('notion'), { root, env });
  skipped.skip();
  assert.equal((await skipped.done).status, 'skipped');
  const failing = createConnectFlow(findCatalogConnector('notion'), { root, env, deps: { loginMcpServer: async () => { throw new Error('The server refused sign-in: access_denied'); } } });
  failing.connect();
  const final = await failing.done;
  assert.equal(final.status, 'failed');
  assert.match(final.message, /access_denied/);
});

test('connect_service reports an already-connected service without showing a card', async (t) => {
  const { root, env } = await sandbox(t);
  const session = fakeSession(root);
  session.mcpClients.set('linear', { config: { name: 'linear', type: 'http', url: 'https://mcp.linear.app/mcp' }, tools: [{ name: 'list_issues' }] });
  let shown = false;
  const result = await runConnectService(session, { service: 'linear' }, { env, connectorCard: async () => { shown = true; } });
  assert.equal(result.connected, true);
  assert.equal(result.alreadyConnected, true);
  assert.equal(shown, false);
});

test('connect_service shows a card and returns what the user chose', async (t) => {
  const { root, env } = await sandbox(t);
  const session = fakeSession(root);
  const result = await runConnectService(session, { service: 'sentry', reason: 'read the crash' }, { env, connectorCard: async (flow) => {
    assert.equal(flow.view().connector.name, 'Sentry');
    assert.equal(flow.view().reason, 'read the crash');
    flow.skip();
    return flow.done;
  } });
  assert.equal(result.connected, false);
  assert.equal(result.skipped, true);
  const headless = await runConnectService(session, { service: 'sentry' }, { env });
  assert.match(headless.message, /oasis mcp connect sentry/);
  const unknown = await runConnectService(session, { service: 'https://' }, { env });
  assert.equal(unknown.connected, false);
});

test('gh device prompt parsing and terminal card', async () => {
  assert.deepEqual(parseGhDevicePrompt('! First copy your one-time code: C152-46A1\nOpen this URL to continue in your web browser: https://github.com/login/device'), { code: 'C152-46A1', url: 'https://github.com/login/device' });
  assert.equal(parseGhDevicePrompt('nothing'), null);
  const lines = terminalCardLines({ connector: { name: 'Linear', description: 'Issues.', auth: 'oauth' }, reason: '' }, 60);
  assert.ok(lines[0].startsWith('┌') && lines.at(-1).startsWith('└'));
  assert.ok(lines.every((line) => line.length === lines[0].length));
  let out = '';
  const flow = createConnectFlow(findCatalogConnector('notion'), { env: {} });
  const final = await connectInTerminal(flow, { write: (text) => { out += text; }, askLine: async () => 'n' });
  assert.equal(final.status, 'skipped');
  assert.match(out, /Connect Notion/);
});

test('disconnect forgets the sign-in and the mcp.json entry OASIS added', async (t) => {
  const { root, env } = await sandbox(t);
  const { disconnectConnector, listConnectors } = await import('../src/connectors.mjs');
  const flow = createConnectFlow(findCatalogConnector('notion'), { root, env, deps: { loginMcpServer: async (server, options) => { await saveStoredToken(server.url, { accessToken: 'tok' }, options.env); return { ok: true }; } } });
  flow.connect();
  assert.equal((await flow.done).status, 'connected');
  assert.equal((await listConnectors({ root, env })).find((row) => row.id === 'notion').connected, true);
  const result = await disconnectConnector('notion', { root, env });
  assert.equal(result.signedOut, true);
  assert.equal(result.removed, true);
  assert.equal(await getStoredToken('https://mcp.notion.com/mcp', env), null);
  assert.equal((await listConnectors({ root, env })).find((row) => row.id === 'notion').connected, false);
  assert.match((await disconnectConnector('notion', { root, env })).message, /was not connected/);
});

test('terminal Tab completion after /connect lists apps', async () => {
  const { createCompleter } = await import('../src/completion.mjs');
  const complete = createCompleter({ root: process.cwd(), commands: async () => [] });
  const result = await complete('/connect li', 11);
  assert.deepEqual(result.candidates.map((item) => item.value), ['linear']);
  assert.equal(result.start, 9);
  const all = await complete('/connect ', 9);
  assert.ok(all.candidates.length > 15);
});

test('lazy sign-in: an auth error from a live app shows the card instead of failing', async (t) => {
  const { root, env } = await sandbox(t);
  const { connectAfterAuthError } = await import('../src/agent.mjs');
  const url = 'https://mcp.linear.app/mcp';
  await saveStoredToken(url, { accessToken: 'revoked' }, env);
  const session = fakeSession(root);
  session.mcpClients.set('linear', { config: { name: 'linear', type: 'http', url }, tools: [{ name: 'list_issues' }] });
  session.mcpToolMap = new Map([['mcp_linear_list_issues', {}]]);
  const mapped = { serverName: 'linear', toolName: 'list_issues' };
  const authError = Object.assign(new Error('needs sign-in'), { code: 'MCP_AUTH_REQUIRED' });
  let shown = null;
  const options = { env, connectorCard: async (flow) => { shown = flow.view(); flow.skip(); return flow.done; } };
  assert.equal(await connectAfterAuthError(session, mapped, authError, options), false);
  assert.equal(shown.connector.url, url);
  assert.match(shown.reason, /linear needs you to sign in before it can run list_issues/);
  assert.equal(await getStoredToken(url, env), null, 'the rejected token is forgotten');
  // No one to click, a scope step-up, or another error: the usual error stands.
  assert.equal(await connectAfterAuthError(session, mapped, authError, { env }), false);
  assert.equal(await connectAfterAuthError(session, mapped, Object.assign(new Error('x'), { code: 'MCP_AUTH_REQUIRED', requiredScope: 'write' }), options), false);
  assert.equal(await connectAfterAuthError(session, mapped, new Error('boom'), options), false);
});

test('/disconnect signs out from the terminal', async (t) => {
  const { root, env } = await sandbox(t);
  const { runBuiltinCommand } = await import('../src/slash.mjs');
  await saveStoredToken('https://mcp.notion.com/mcp', { accessToken: 'x' }, env);
  const result = await runBuiltinCommand('disconnect', 'notion', { root, env });
  assert.match(result.output, /Notion: signed out/);
  assert.match((await runBuiltinCommand('disconnect', '', { root, env })).output, /Usage: \/disconnect NAME/);
});
