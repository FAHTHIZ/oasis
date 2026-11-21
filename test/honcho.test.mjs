import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  honchoConfig, honchoId, honchoSessionId, createHonchoState, syncHonchoTurn, honchoContextPrompt,
  runHonchoTool, honchoCommand, scopeHonchoToChat, HONCHO_TOOL_DEFINITIONS, HONCHO_TOOL_NAMES
} from '../src/honcho.mjs';
import { READ_ONLY_TOOLS } from '../src/agent.mjs';

function fakeHoncho(responses = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), body, auth: init.headers.authorization });
    const key = init.method + ' ' + parsed.pathname;
    const value = typeof responses[key] === 'function' ? responses[key](body) : responses[key];
    if (value && value.status) return new Response(JSON.stringify(value.body || {}), { status: value.status });
    return new Response(JSON.stringify(value === undefined ? {} : value), { status: 200 });
  };
  return { calls, fetchImpl };
}

const env = { HONCHO_API_KEY: 'hch-test-key', USER: 'fahim' };

test('honcho is off without a key or URL and can be turned off', () => {
  assert.equal(honchoConfig({}), null);
  assert.equal(honchoConfig({ ...env, OASIS_HONCHO: '0' }), null);
  assert.equal(honchoConfig(env, { honcho: { enabled: false } }), null);
  const config = honchoConfig(env);
  assert.equal(config.baseUrl, 'https://api.honcho.dev');
  assert.equal(config.userPeer, 'fahim');
  assert.equal(config.aiPeer, 'oasis');
  assert.equal(config.recallMode, 'hybrid');
  assert.equal(config.sessionStrategy, 'per-directory');
  const selfHosted = honchoConfig({ HONCHO_URL: 'http://localhost:8000/', USER: 'a b' }, { honcho: { recallMode: 'TOOLS', sessionStrategy: 'global', contextTokens: 50, workspace: 'my space' } });
  assert.equal(selfHosted.baseUrl, 'http://localhost:8000');
  assert.equal(selfHosted.apiKey, '');
  assert.equal(selfHosted.userPeer, 'a-b');
  assert.equal(selfHosted.workspace, 'my-space');
  assert.equal(selfHosted.recallMode, 'tools');
  assert.equal(selfHosted.contextTokens, 100);
  assert.equal(honchoConfig({ HONCHO_URL: 'ftp://x' }), null);
});

test('session ids follow the strategy and stay valid Honcho ids', async () => {
  assert.equal(honchoId('a/b c!'), 'a-b-c');
  const root = await mkdtemp(join(tmpdir(), 'oasis-honcho-'));
  await mkdir(join(root, '.git'));
  await mkdir(join(root, 'pkg', 'sub'), { recursive: true });
  const base = honchoConfig(env);
  const dirA = honchoSessionId(base, { root: join(root, 'pkg') });
  const dirB = honchoSessionId(base, { root: join(root, 'pkg', 'sub') });
  assert.notEqual(dirA, dirB);
  assert.match(dirA, /^dir-pkg-[0-9a-f]{10}$/);
  const repo = { ...base, sessionStrategy: 'per-repo' };
  assert.equal(honchoSessionId(repo, { root: join(root, 'pkg') }), honchoSessionId(repo, { root: join(root, 'pkg', 'sub') }));
  assert.equal(honchoSessionId({ ...base, sessionStrategy: 'global' }, { root }), 'oasis-global');
  assert.equal(honchoSessionId({ ...base, sessionStrategy: 'per-session' }, { root, sessionId: '2026-01-01_abc' }), 'session-2026-01-01_abc');
  assert.equal(honchoSessionId(base, { root, platform: 'telegram', chatId: '-100123' }), 'telegram--100123');
});

test('a finished turn is synced with the user observed and secrets redacted', async () => {
  const { calls, fetchImpl } = fakeHoncho();
  const state = createHonchoState(honchoConfig(env), { root: '/tmp/project' });
  const ok = await syncHonchoTurn(state, 'deploy with key sk-ant-api03-' + 'x'.repeat(40) + ' <private>my pin 1234</private>\n<system-reminder>internal</system-reminder>', 'Deployed.', { fetchImpl });
  assert.equal(ok, true);
  assert.deepEqual(calls.map((call) => call.method + ' ' + call.path).slice(0, 2), ['POST /v3/workspaces', 'POST /v3/workspaces/oasis/peers']);
  const peers = calls.find((call) => call.path.endsWith('/sessions/' + state.sessionId + '/peers'));
  assert.deepEqual(peers.body.fahim, { observe_me: true, observe_others: false });
  assert.equal(peers.body.oasis.observe_me, false);
  const sent = calls.at(-1);
  assert.equal(sent.path, '/v3/workspaces/oasis/sessions/' + state.sessionId + '/messages');
  assert.equal(sent.auth, 'Bearer hch-test-key');
  assert.equal(sent.body.messages[0].peer_id, 'fahim');
  assert.doesNotMatch(sent.body.messages[0].content, /sk-ant|1234|internal/);
  assert.equal(sent.body.messages[1].content, 'Deployed.');
  assert.equal(state.synced, 2);
  // The workspace/peers/session are created once per state.
  await syncHonchoTurn(state, 'again', 'ok', { fetchImpl });
  assert.equal(calls.filter((call) => call.path === '/v3/workspaces').length, 1);
});

test('sync fails open and remembers the error', async () => {
  const { fetchImpl } = fakeHoncho({ 'POST /v3/workspaces': { status: 401, body: { detail: 'bad key' } } });
  const state = createHonchoState(honchoConfig(env), { root: '/tmp/p' });
  assert.equal(await syncHonchoTurn(state, 'hi', 'hello', { fetchImpl }), false);
  assert.match(state.lastError, /401.*HONCHO_API_KEY.*bad key/);
  const off = createHonchoState({ ...honchoConfig(env), sync: false }, { root: '/tmp/p' });
  assert.equal(await syncHonchoTurn(off, 'hi', 'hello', { fetchImpl }), false);
});

test('the system prompt block carries the peer card and representation within budget', async () => {
  const { fetchImpl, calls } = fakeHoncho({ 'GET /v3/workspaces/oasis/peers/fahim/context': { peer_card: ['Name: Fahim', 'Lives in Dhaka'], representation: 'Prefers terse answers. ' + 'x'.repeat(10_000) } });
  const state = createHonchoState({ ...honchoConfig(env), contextTokens: 200 }, { root: '/tmp/p' });
  const text = await honchoContextPrompt(state, { fetchImpl });
  assert.match(text, /^<honcho-user-model peer="fahim">/);
  assert.match(text, /- Name: Fahim/);
  assert.match(text, /Prefers terse answers/);
  assert.ok(text.length < 1200);
  assert.equal(calls.length, 1);
  assert.equal(await honchoContextPrompt({ ...state, config: { ...state.config, recallMode: 'tools' } }, { fetchImpl }), '');
  const failing = fakeHoncho({ 'GET /v3/workspaces/oasis/peers/fahim/context': { status: 500 } });
  assert.equal(await honchoContextPrompt(state, { fetchImpl: failing.fetchImpl }), '');
});

test('the five tools call the matching Honcho endpoints', async () => {
  assert.deepEqual(HONCHO_TOOL_DEFINITIONS.map((tool) => tool.function.name), HONCHO_TOOL_NAMES);
  for (const name of ['honcho_search', 'honcho_context', 'honcho_reasoning']) assert.ok(READ_ONLY_TOOLS.has(name), name);
  assert.ok(!READ_ONLY_TOOLS.has('honcho_conclude'));
  const { calls, fetchImpl } = fakeHoncho({
    'GET /v3/workspaces/oasis/peers/fahim/card': { peer_card: ['Name: Fahim'] },
    'PUT /v3/workspaces/oasis/peers/fahim/card': (body) => ({ peer_card: body.peer_card }),
    'POST /v3/workspaces/oasis/peers/fahim/search': [{ peer_id: 'fahim', session_id: 'dir-x', content: 'I like vitest', created_at: '2026-05-01T10:00:00Z' }],
    'POST /v3/workspaces/oasis/peers/fahim/chat': { content: 'They prefer vitest.' },
    'POST /v3/workspaces/oasis/conclusions': { items: [{ id: 'c1', content: 'x' }] },
    'POST /v3/workspaces/oasis/conclusions/list': { items: [{ id: 'c1', content: 'Prefers vitest' }] }
  });
  const state = createHonchoState(honchoConfig(env), { root: '/tmp/p' });
  const run = (name, args) => runHonchoTool(name, args, { state, fetchImpl });
  assert.match(await run('honcho_profile', { action: 'get' }), /- Name: Fahim/);
  assert.match(await run('honcho_profile', { action: 'set', card: ['Name: Fahim', 'token=abcdef123456'] }), /2 facts/);
  assert.deepEqual(calls.find((call) => call.method === 'PUT').body.peer_card, ['Name: Fahim', 'token=[redacted]']);
  await assert.rejects(run('honcho_profile', { action: 'set', card: [] }), /needs card/);
  assert.match(await run('honcho_search', { query: 'tests', limit: 500 }), /2026-05-01 10:00 fahim \[dir-x\]: I like vitest/);
  assert.equal(calls.find((call) => call.path.endsWith('/search')).body.limit, 50);
  assert.equal(await run('honcho_reasoning', { query: 'test style?', reasoning_level: 'high', this_session_only: true }), 'They prefer vitest.');
  const chat = calls.find((call) => call.path.endsWith('/chat'));
  assert.deepEqual(chat.body, { query: 'test style?', reasoning_level: 'high', stream: false, session_id: state.sessionId });
  assert.match(await run('honcho_context', {}), /no context for this thread yet/);
  const ctx = calls.find((call) => call.path.endsWith('/context'));
  assert.equal(ctx.query.peer_target, 'fahim');
  assert.equal(ctx.query.summary, 'true');
  assert.match(await run('honcho_conclude', { action: 'create', content: 'Prefers vitest' }), /Recorded the conclusion c1/);
  const created = calls.find((call) => call.path === '/v3/workspaces/oasis/conclusions');
  assert.deepEqual(created.body.conclusions[0], { content: 'Prefers vitest', observer_id: 'oasis', observed_id: 'fahim', session_id: state.sessionId });
  assert.match(await run('honcho_conclude', { action: 'list' }), /c1: Prefers vitest/);
  assert.match(await run('honcho_conclude', { action: 'delete', id: 'c1' }), /Deleted conclusion c1/);
  await assert.rejects(run('honcho_conclude', { action: 'delete', id: '../x' }), /needs the conclusion id/);
  await assert.rejects(runHonchoTool('honcho_search', { query: 'x' }, {}), /not configured/);
});

test('chat gateways get their own thread but the same user peer', () => {
  const session = { honcho: createHonchoState(honchoConfig(env), { root: '/tmp/p' }) };
  scopeHonchoToChat(session, 'discord', '42');
  assert.equal(session.honcho.sessionId, 'discord-42');
  assert.equal(session.honcho.config.userPeer, 'fahim');
});

test('oasis honcho status and test', async () => {
  assert.match((await honchoCommand([], { env: {} })).text, /Honcho is off/);
  const status = await honchoCommand(['status'], { env, root: '/tmp/p' });
  assert.match(status.text, /api\.honcho\.dev \(API key set\)/);
  assert.match(status.text, /user peer: fahim/);
  const { fetchImpl } = fakeHoncho({ 'GET /v3/workspaces/oasis/peers/fahim/card': { peer_card: ['a', 'b'] } });
  const tested = await honchoCommand(['test'], { env, root: '/tmp/p', fetchImpl });
  assert.equal(tested.exitCode, 0);
  assert.match(tested.text, /Connected\. Peer card: 2 facts/);
  const bad = fakeHoncho({ 'POST /v3/workspaces': { status: 403 } });
  assert.equal((await honchoCommand(['test'], { env, root: '/tmp/p', fetchImpl: bad.fetchImpl })).exitCode, 1);
  assert.equal((await honchoCommand(['nope'], { env })).exitCode, 2);
});
