import test from 'node:test';
import assert from 'node:assert/strict';
import { createMatrixGateway, deliverMatrix, matrixMentions, parseMxc, stripMatrixMention } from '../src/gateway-matrix.mjs';
import { parseApprovalReply, parseList, createChatCore } from '../src/gateway-core.mjs';
import { parseDeliver, deliverOutput } from '../src/routines.mjs';
import { mkdtempSync as pairMkdtemp } from 'node:fs';
import { tmpdir as pairTmpdir } from 'node:os';
import { join as pairJoin } from 'node:path';
const PAIR_ROOT = pairMkdtemp(pairJoin(pairTmpdir(), 'oasis-pair-'));

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function fakeAgent(onTurn) {
  return {
    createSession: async () => ({ messages: [], config: { model: 'm' }, permissions: { mode: 'default' } }),
    runAgentTurn: async (session, text, options) => onTurn(session, text, options)
  };
}
const deps = (agent) => ({ agent, config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) } });

function fakeHomeserver(handlers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    const parsed = new URL(url);
    calls.push({ url, path: parsed.pathname, method: init.method || 'GET', body, headers: init.headers });
    for (const [pattern, respond] of Object.entries(handlers)) {
      if (parsed.pathname.includes(pattern)) {
        const result = respond(parsed, body);
        if (result instanceof Response) return result;
        return new Response(JSON.stringify(result || {}), { status: 200 });
      }
    }
    return new Response(JSON.stringify({}), { status: 200 });
  };
  return { calls, fetchImpl };
}

test('approval replies and list parsing', () => {
  assert.deepEqual(parseApprovalReply('yes'), { kind: 'allow', id: null });
  assert.deepEqual(parseApprovalReply('allow 3'), { kind: 'allow', id: '3' });
  assert.deepEqual(parseApprovalReply('/reject #12'), { kind: 'reject', id: '12' });
  assert.deepEqual(parseApprovalReply('Always 2.'), { kind: 'always', id: '2' });
  assert.equal(parseApprovalReply('yes please fix the bug'), null);
  assert.equal(parseApprovalReply('run the tests'), null);
  assert.deepEqual([...parseList('@me:example.org, +15551234567; a@b.co')], ['@me:example.org', '+15551234567', 'a@b.co']);
});

test('matrix helpers', () => {
  assert.deepEqual(parseMxc('mxc://example.org/AbC_12-x'), ['example.org', 'AbC_12-x']);
  assert.equal(parseMxc('https://evil/x'), null);
  assert.equal(parseMxc('mxc://example.org/../x'), null);
  assert.equal(stripMatrixMention('OASIS: run the tests', '@bot:x', 'OASIS'), 'run the tests');
  assert.equal(stripMatrixMention('@bot:x fix it', '@bot:x', ''), 'fix it');
  assert.ok(matrixMentions({ body: 'hey', 'm.mentions': { user_ids: ['@bot:x'] } }, '@bot:x', ''));
  assert.ok(matrixMentions({ body: 'oasis, look' }, '@bot:x', 'Oasis'));
  assert.ok(!matrixMentions({ body: 'oasisland' }, '@bot:x', 'Oasis'));
});

test('matrix requires homeserver, token and allowlist', () => {
  assert.throws(() => createMatrixGateway({ env: {} }), /HOMESERVER/);
  assert.throws(() => createMatrixGateway({ env: { OASIS_MATRIX_HOMESERVER: 'https://m.org' } }), /ACCESS_TOKEN/);
  assert.throws(() => createMatrixGateway({ env: { OASIS_GATEWAY_PAIRING: '0', OASIS_MATRIX_HOMESERVER: 'https://m.org', OASIS_MATRIX_ACCESS_TOKEN: 'syt_abcdefgh' } }), /ALLOWED_USERS/);
});

test('matrix joins invites from allowed users, skips history, answers DMs and typed approvals', async () => {
  const server = fakeHomeserver({ '/join/': () => ({ room_id: '!dm:m.org' }), '/leave': () => ({}) });
  let approved;
  const turns = [];
  const agent = fakeAgent(async (_s, text, options) => { turns.push(text); approved = await options.approval('Run npm test?', false, { suggestion: 'Bash(npm test)' }); return { text: 'done: ' + text }; });
  const gateway = createMatrixGateway({ homeserver: 'https://m.org', token: 'syt_token_123', allowedUsers: new Set(['@me:m.org']), userId: '@bot:m.org', fetchImpl: server.fetchImpl, deps: deps(agent), root: PAIR_ROOT, log: () => {} });

  await gateway.handleSync({
    next_batch: 's1',
    rooms: {
      invite: {
        '!dm:m.org': { invite_state: { events: [{ type: 'm.room.member', state_key: '@bot:m.org', sender: '@me:m.org' }] } },
        '!spam:m.org': { invite_state: { events: [{ type: 'm.room.member', state_key: '@bot:m.org', sender: '@stranger:m.org' }] } }
      },
      join: { '!dm:m.org': { summary: { 'm.joined_member_count': 2 }, timeline: { events: [{ type: 'm.room.message', sender: '@me:m.org', content: { msgtype: 'm.text', body: 'old history' } }] } } }
    }
  }, { initial: true });
  assert.ok(server.calls.some((c) => c.path.endsWith('/join/' + encodeURIComponent('!dm:m.org'))));
  assert.ok(server.calls.some((c) => c.path.includes(encodeURIComponent('!spam:m.org')) && c.path.endsWith('/leave')));
  assert.equal(turns.length, 0, 'initial sync never replays history');

  await gateway.handleSync({ next_batch: 's2', rooms: { join: { '!dm:m.org': { timeline: { events: [{ type: 'm.room.message', sender: '@me:m.org', content: { msgtype: 'm.text', body: 'run the tests' } }] } } } } });
  await flush();
  assert.deepEqual(turns, ['run the tests']);
  const sends = () => server.calls.filter((c) => c.method === 'PUT' && c.path.includes('/send/m.room.message/'));
  const ask = sends().find((c) => /Approval needed/.test(c.body.body));
  assert.ok(ask, 'approval request was posted');
  assert.match(ask.body.body, /allow 1.*always 1.*reject 1/s);
  await gateway.handleEvent('!dm:m.org', { type: 'm.room.message', sender: '@me:m.org', content: { msgtype: 'm.text', body: 'always' } });
  await flush();
  assert.equal(approved, 'always');
  assert.ok(sends().some((c) => c.body.body === 'done: run the tests'));
});

test('matrix ignores strangers once, encrypted rooms and unmentioned group messages', async () => {
  const server = fakeHomeserver();
  const turns = [];
  const agent = fakeAgent(async (_s, text) => { turns.push(text); return { text: 'ok' }; });
  const gateway = createMatrixGateway({ homeserver: 'https://m.org', token: 'syt_token_123', allowedUsers: new Set(['@me:m.org']), userId: '@bot:m.org', displayName: 'Oasis', fetchImpl: server.fetchImpl, deps: deps(agent), root: PAIR_ROOT, log: () => {} });
  gateway.memberCounts.set('!group:m.org', 8);
  gateway.memberCounts.set('!dm:m.org', 2);
  await gateway.handleEvent('!group:m.org', { type: 'm.room.message', sender: '@me:m.org', content: { msgtype: 'm.text', body: 'chatting with people' } });
  await gateway.handleEvent('!dm:m.org', { type: 'm.room.message', sender: '@x:m.org', content: { msgtype: 'm.text', body: 'hi' } });
  await gateway.handleEvent('!dm:m.org', { type: 'm.room.message', sender: '@x:m.org', content: { msgtype: 'm.text', body: 'hi again' } });
  await gateway.handleEvent('!dm:m.org', { type: 'm.room.encrypted', sender: '@me:m.org', content: {} });
  await gateway.handleEvent('!dm:m.org', { type: 'm.room.encrypted', sender: '@me:m.org', content: {} });
  await gateway.handleEvent('!group:m.org', { type: 'm.room.message', sender: '@me:m.org', content: { msgtype: 'm.text', body: 'Oasis: summarise the README' } });
  await flush();
  const bodies = server.calls.filter((c) => c.method === 'PUT' && c.path.includes('/send/')).map((c) => c.body.body);
  assert.equal(bodies.filter((b) => /Your Matrix ID is @x:m.org/.test(b)).length, 1);
  assert.equal(bodies.filter((b) => /end-to-end encrypted/.test(b)).length, 1);
  assert.deepEqual(turns, ['summarise the README']);
});

test('matrix downloads attachments through authenticated media', async () => {
  const server = fakeHomeserver({ '/media/download/': () => new Response(Buffer.from('PNGDATA'), { status: 200 }) });
  const seen = [];
  const agent = fakeAgent(async (_s, text, options) => { seen.push({ text, images: options.images }); return { text: 'ok' }; });
  const os = await import('node:os');
  const fs = await import('node:fs/promises');
  const root = await fs.mkdtemp((await import('node:path')).join(os.tmpdir(), 'oasis-matrix-'));
  const gateway = createMatrixGateway({ root, homeserver: 'https://m.org', token: 'syt_token_123', allowedUsers: new Set(['@me:m.org']), userId: '@bot:m.org', fetchImpl: server.fetchImpl, deps: deps(agent), transcribe: null, log: () => {} });
  gateway.memberCounts.set('!dm:m.org', 2);
  await gateway.handleEvent('!dm:m.org', { type: 'm.room.message', sender: '@me:m.org', content: { msgtype: 'm.image', body: 'shot.png', url: 'mxc://m.org/abc123', info: { mimetype: 'image/png', size: 7 } } });
  await flush();
  assert.ok(server.calls.some((c) => c.path === '/_matrix/client/v1/media/download/m.org/abc123'));
  assert.equal(seen.length, 1);
  assert.match(seen[0].text, /\.oasis\/inbox\/.*shot\.png/);
  assert.equal(seen[0].images.length, 1);
  await fs.rm(root, { recursive: true, force: true });
});

test('chat core: typed approvals with several pending ask for the number', async () => {
  const sent = [];
  const resolvers = [];
  const agent = fakeAgent(async (_s, _text, options) => {
    const first = options.approval('one?', false, {});
    const second = options.approval('two?', false, {});
    resolvers.push(first, second);
    return { text: String(await first) + ',' + String(await second) };
  });
  const core = createChatCore({ send: async (key, text) => { sent.push(text); }, deps: deps(agent), textApprovals: true, transcribe: null, root: PAIR_ROOT, log: () => {} });
  await core.handleText('c', 'go');
  await flush();
  await core.handleText('c', 'yes');
  assert.ok(sent.some((t) => /Several approvals are waiting: 1, 2/.test(t)));
  await core.handleText('c', 'allow 2');
  await core.handleText('c', 'no 1');
  await flush();
  assert.ok(sent.includes('false,true'));
});

test('matrix routine delivery', async () => {
  assert.equal(parseDeliver('matrix:!abc:m.org'), 'matrix:!abc:m.org');
  const server = fakeHomeserver();
  await deliverOutput({ id: 'r1', deliver: 'matrix:!abc:m.org' }, 'daily report', { env: { OASIS_MATRIX_HOMESERVER: 'https://m.org', OASIS_MATRIX_ACCESS_TOKEN: 'syt_x_12345' }, fetchImpl: server.fetchImpl });
  const put = server.calls.find((c) => c.method === 'PUT');
  assert.ok(put.path.startsWith('/_matrix/client/v3/rooms/' + encodeURIComponent('!abc:m.org') + '/send/m.room.message/'));
  assert.match(put.body.body, /daily report/);
  await assert.rejects(() => deliverMatrix('!a:b', 'x', { env: {} }), /OASIS_MATRIX_HOMESERVER/);
});
