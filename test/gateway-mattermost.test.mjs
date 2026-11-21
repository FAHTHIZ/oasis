import test from 'node:test';
import assert from 'node:assert/strict';
import { createMattermostGateway, deliverMattermost, parsePostedEvent, splitChatKey } from '../src/gateway-mattermost.mjs';
import { parseDeliver } from '../src/routines.mjs';

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const BOT = { id: 'b'.repeat(26), username: 'oasis' };
const ALICE = 'a'.repeat(26);
const EVE = 'e'.repeat(26);
const DM = 'd'.repeat(26);
const CHAN = 'c'.repeat(26);
const FILE = 'f'.repeat(26);

const deps = (agent) => ({ agent, config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) } });
function fakeAgent(onTurn) {
  return { createSession: async () => ({ messages: [], config: { model: 'm' }, permissions: { mode: 'default' } }), runAgentTurn: async (session, text, options) => onTurn(session, text, options) };
}
function fakeApi() {
  const posts = [];
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    const route = url.replace('https://chat.example.com/api/v4', '');
    if (route === '/users/me') return Response.json(BOT);
    if (route === '/users/' + ALICE) return Response.json({ id: ALICE, username: 'alice' });
    if (route === '/users/' + EVE) return Response.json({ id: EVE, username: 'eve' });
    if (route === '/files/' + FILE + '/info') return Response.json({ name: 'notes.txt', mime_type: 'text/plain', size: 5 });
    if (route === '/files/' + FILE) return new Response('hello');
    if (route === '/posts') { posts.push(JSON.parse(init.body)); return Response.json({ id: 'p' }); }
    return new Response('{}', { status: 404 });
  };
  return { posts, calls, fetchImpl };
}
const posted = (post, data = {}) => ({ event: 'posted', data: { post: JSON.stringify({ type: '', file_ids: [], ...post }), channel_type: 'D', ...data } });

function gatewayFor(agent, api, extra = {}) {
  const gateway = createMattermostGateway({ url: 'https://chat.example.com', token: 'x'.repeat(26), allowedUsers: new Set(['alice']), channels: new Set(), fetchImpl: api.fetchImpl, deps: deps(agent), transcribe: null, log: () => {}, me: BOT, ...extra });
  return gateway;
}

test('event parsing and chat keys', () => {
  assert.equal(parsePostedEvent({ event: 'typing' }), null);
  assert.equal(parsePostedEvent(posted({ id: 'x', channel_id: DM, user_id: ALICE, type: 'system_join_channel' })), null);
  const post = parsePostedEvent(posted({ id: 'x', channel_id: CHAN, user_id: ALICE, message: 'hi', root_id: 'r' }, { channel_type: 'O', mentions: JSON.stringify([BOT.id]) }));
  assert.deepEqual([post.channelId, post.rootId, post.text, post.mentions], [CHAN, 'r', 'hi', [BOT.id]]);
  assert.deepEqual(splitChatKey(CHAN + ':root'), { channelId: CHAN, rootId: 'root' });
  assert.throws(() => createMattermostGateway({ env: {} }), /OASIS_MATTERMOST_URL/);
  assert.throws(() => createMattermostGateway({ env: { OASIS_MATTERMOST_URL: 'https://chat.example.com', OASIS_MATTERMOST_TOKEN: 'x'.repeat(26) } }), /ALLOWED_USERS/);
});

test('direct messages run tasks with typed approvals; usernames are allowlisted', async () => {
  const api = fakeApi();
  let decision;
  const agent = fakeAgent(async (_s, text, options) => { decision = await options.approval('Run npm test?', false, {}); return { text: 'done: ' + text }; });
  const gateway = gatewayFor(agent, api);
  await gateway.handleEvent(posted({ id: 'p1', channel_id: DM, user_id: ALICE, message: 'run the tests' }));
  await flush();
  assert.match(api.posts.at(-1).message, /Run npm test\?/);
  assert.equal(api.posts.at(-1).channel_id, DM);
  assert.equal(api.posts.at(-1).root_id, undefined);
  await gateway.handleEvent(posted({ id: 'p2', channel_id: DM, user_id: ALICE, message: 'yes' }));
  await flush();
  assert.ok(decision === true || decision === 'allow', String(decision));
  assert.equal(api.posts.at(-1).message, 'done: run the tests');
  gateway.stop();
});

test('channels: ignored unless mentioned, answered in the thread, mention stripped; own posts and strangers', async () => {
  const api = fakeApi();
  const seen = [];
  const gateway = gatewayFor(fakeAgent(async (_s, text) => { seen.push(text); return { text: 'ok' }; }), api);
  await gateway.handleEvent(posted({ id: 'q1', channel_id: CHAN, user_id: ALICE, message: 'chatting' }, { channel_type: 'O' }));
  await gateway.handleEvent(posted({ id: 'q2', channel_id: DM, user_id: BOT.id, message: 'my own reply' }));
  await flush();
  assert.equal(seen.length, 0);
  await gateway.handleEvent(posted({ id: 'q3', channel_id: CHAN, user_id: ALICE, message: '@oasis summarize the release' }, { channel_type: 'O', mentions: JSON.stringify([BOT.id]) }));
  await flush();
  assert.deepEqual(seen, ['summarize the release']);
  assert.deepEqual([api.posts.at(-1).channel_id, api.posts.at(-1).root_id], [CHAN, 'q3']);
  await gateway.handleEvent(posted({ id: 'q4', channel_id: DM, user_id: EVE, message: 'hi' }));
  await gateway.handleEvent(posted({ id: 'q5', channel_id: DM, user_id: EVE, message: 'hi' }));
  assert.equal(api.posts.filter((p) => /not allowed.*@eve/.test(p.message)).length, 1);
  assert.equal(seen.length, 1);
  gateway.stop();
});

test('attachments are downloaded with the token', async () => {
  const os = await import('node:os'); const fs = await import('node:fs/promises'); const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oasis-mm-'));
  const api = fakeApi();
  const seen = [];
  const gateway = gatewayFor(fakeAgent(async (_s, text) => { seen.push(text); return { text: 'ok' }; }), api, { root });
  await gateway.handleEvent(posted({ id: 'r1', channel_id: DM, user_id: ALICE, message: 'read this', file_ids: [FILE] }));
  await flush();
  assert.match(seen[0], /read this[\s\S]*notes\.txt/);
  const download = api.calls.find((c) => c.url.endsWith('/files/' + FILE));
  assert.equal(download.init.headers.authorization, 'Bearer ' + 'x'.repeat(26));
  gateway.stop();
  await fs.rm(root, { recursive: true, force: true });
});

test('websocket authenticates with a challenge', async () => {
  const sent = [];
  class FakeSocket extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 1; FakeSocket.last = this; setTimeout(() => this.dispatchEvent(new Event('open')), 0); }
    send(data) { sent.push(JSON.parse(data)); }
    close() { this.dispatchEvent(new Event('close')); }
  }
  const api = fakeApi();
  const gateway = gatewayFor(fakeAgent(async () => ({ text: '' })), api, { WebSocketImpl: FakeSocket });
  const done = gateway.connect();
  await flush();
  assert.equal(FakeSocket.last.url, 'wss://chat.example.com/api/v4/websocket');
  assert.deepEqual(sent[0].action, 'authentication_challenge');
  assert.equal(sent[0].data.token, 'x'.repeat(26));
  gateway.stop();
  await done;
});

test('mattermost routine delivery', async () => {
  assert.equal(parseDeliver('mattermost:' + CHAN), 'mattermost:' + CHAN);
  const api = fakeApi();
  await deliverMattermost(CHAN, 'report', { env: { OASIS_MATTERMOST_URL: 'https://chat.example.com', OASIS_MATTERMOST_TOKEN: 'x'.repeat(26) }, fetchImpl: api.fetchImpl });
  assert.deepEqual(api.posts[0], { channel_id: CHAN, message: 'report' });
  await assert.rejects(() => deliverMattermost(CHAN, 'x', { env: {} }), /OASIS_MATTERMOST_URL/);
});
