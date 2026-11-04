import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscordGateway, stripMention, DISCORD_INTENTS } from '../src/gateway-discord.mjs';
import { createSlackGateway, slackChatKey, stripSlackMention } from '../src/gateway-slack.mjs';
import { parseIdList, chunkText } from '../src/gateway-core.mjs';

const DISCORD_TOKEN = 'M'.repeat(24) + '.' + 'G'.repeat(6) + '.' + 'x'.repeat(38);
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

function fakeAgent(onTurn) {
  return {
    createSession: async () => ({ messages: [], config: { model: 'm' }, permissions: { mode: 'default', setMode(mode) { this.mode = mode; } } }),
    runAgentTurn: async (session, text, options) => onTurn(session, text, options)
  };
}
const deps = (agent) => ({ agent, config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) } });

function fakeHttp(respond = () => ({})) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method, headers: init.headers, body });
    return new Response(JSON.stringify({ ok: true, ...respond(url, body) }), { status: 200 });
  };
  return { calls, fetchImpl };
}

class FakeSocket {
  static last = null;
  constructor(url) { this.url = url; this.sent = []; this.listeners = {}; FakeSocket.last = this; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  send(data) { this.sent.push(JSON.parse(data)); }
  close() { for (const fn of this.listeners.close || []) fn({}); }
  emit(packet) { for (const fn of this.listeners.message || []) fn({ data: JSON.stringify(packet) }); }
}

test('shared helpers', () => {
  assert.deepEqual([...parseIdList('123, U01ABC  bad!id')], ['123', 'U01ABC']);
  assert.equal(chunkText('a'.repeat(25), 10).length, 3);
  assert.equal(stripMention('<@99> fix it <@!99>', '99'), 'fix it');
  assert.equal(stripSlackMention('<@UBOT> run tests', 'UBOT'), 'run tests');
  assert.equal(slackChatKey({ channel: 'D1', channel_type: 'im', ts: '1.0' }), 'D1');
  assert.equal(slackChatKey({ channel: 'C1', channel_type: 'channel', ts: '1.0', thread_ts: '0.5' }), 'C1:0.5');
});

test('discord requires a token and allowlist', () => {
  assert.throws(() => createDiscordGateway({ env: {} }), /BOT_TOKEN/);
  assert.throws(() => createDiscordGateway({ env: { OASIS_DISCORD_BOT_TOKEN: DISCORD_TOKEN } }), /ALLOWED_USERS/);
});

test('discord identifies, ignores strangers, runs allowed users and handles approval buttons', async () => {
  const http = fakeHttp();
  let approved;
  const agent = fakeAgent(async (_s, text, options) => { approved = await options.approval('Run npm test?', false, { suggestion: 'Bash(npm test)' }); return { text: 'done: ' + text }; });
  const gateway = createDiscordGateway({ token: DISCORD_TOKEN, allowedUsers: new Set(['1']), fetchImpl: http.fetchImpl, WebSocketImpl: FakeSocket, deps: deps(agent), log: () => {} });
  const closed = gateway.connect();
  const ws = FakeSocket.last;
  ws.emit({ op: 10, d: { heartbeat_interval: 60000 } });
  assert.equal(ws.sent[0].op, 2);
  assert.equal(ws.sent[0].d.intents, DISCORD_INTENTS);
  ws.emit({ op: 0, s: 1, t: 'READY', d: { user: { id: '99', username: 'oasis' } } });
  await flush();
  assert.equal(gateway.botId, '99');
  // Guild message without a mention is ignored; a stranger's DM gets their ID once.
  await gateway.handleMessage({ channel_id: 'c', guild_id: 'g', author: { id: '1' }, content: 'hello' });
  await gateway.handleMessage({ channel_id: 'dm2', author: { id: '2' }, content: 'rm -rf /' });
  await gateway.handleMessage({ channel_id: 'dm2', author: { id: '2' }, content: 'again' });
  const posts = () => http.calls.filter((c) => c.url.endsWith('/messages'));
  assert.equal(posts().length, 1);
  assert.match(posts()[0].body.content, /user ID is 2/);
  // An allowed mention runs a turn and shows buttons.
  await gateway.handleMessage({ channel_id: 'c', guild_id: 'g', author: { id: '1' }, content: '<@99> run the tests', mentions: [{ id: '99' }] });
  await flush();
  const ask = posts().find((c) => /Approval needed/.test(c.body.content));
  const ids = ask.body.components[0].components.map((b) => b.custom_id);
  assert.equal(ids.length, 3);
  // A stranger cannot press the button.
  await gateway.handleInteraction({ id: 'i1', token: 't', type: 3, channel_id: 'c', data: { custom_id: ids[1] }, member: { user: { id: '2' } }, message: { content: 'Approval needed' } });
  assert.equal(approved, undefined);
  await gateway.handleInteraction({ id: 'i2', token: 't', type: 3, channel_id: 'c', data: { custom_id: ids[1] }, member: { user: { id: '1' } }, message: { content: 'Approval needed' } });
  await flush();
  assert.equal(approved, 'always');
  const callback = http.calls.find((c) => c.url.includes('/interactions/i2/'));
  assert.equal(callback.body.type, 7);
  assert.match(callback.body.data.content, /Always allowed/);
  assert.match(posts().at(-1).body.content, /done: run the tests/);
  assert.equal(http.calls[0].headers.authorization, 'Bot ' + DISCORD_TOKEN);
  gateway.stop();
  await closed;
});

test('slack requires tokens and allowlist', () => {
  assert.throws(() => createSlackGateway({ env: {} }), /APP_TOKEN/);
  assert.throws(() => createSlackGateway({ env: { OASIS_SLACK_APP_TOKEN: 'xapp-1' } }), /BOT_TOKEN/);
  assert.throws(() => createSlackGateway({ env: { OASIS_SLACK_APP_TOKEN: 'xapp-1', OASIS_SLACK_BOT_TOKEN: 'xoxb-1' } }), /ALLOWED_USERS/);
});

test('slack socket mode acks envelopes, replies in threads, and approves via buttons', async () => {
  const http = fakeHttp((url) => url.endsWith('apps.connections.open') ? { url: 'wss://fake' } : url.endsWith('auth.test') ? { user_id: 'UBOT' } : {});
  let approved;
  const seen = [];
  const agent = fakeAgent(async (_s, text, options) => { seen.push(text); approved = await options.approval('Delete build/?', false, {}); return { text: 'ok' }; });
  const gateway = createSlackGateway({ appToken: 'xapp-1', botToken: 'xoxb-1', allowedUsers: new Set(['U1']), botUserId: 'UBOT', fetchImpl: http.fetchImpl, WebSocketImpl: FakeSocket, deps: deps(agent), log: () => {} });
  const closed = gateway.connect();
  await flush();
  const ws = FakeSocket.last;
  assert.equal(ws.url, 'wss://fake');
  assert.equal(http.calls[0].headers.authorization, 'Bearer xapp-1');
  ws.emit({ envelope_id: 'e1', type: 'events_api', payload: { event: { type: 'app_mention', user: 'U1', channel: 'C1', channel_type: 'channel', ts: '10.1', text: '<@UBOT> clean up' } } });
  await flush();
  assert.deepEqual(ws.sent[0], { envelope_id: 'e1' });
  assert.deepEqual(seen, ['clean up']);
  // Duplicated channel message events and bot messages are ignored.
  await gateway.handleEvent({ type: 'message', user: 'U1', channel: 'C1', channel_type: 'channel', ts: '10.1', text: 'clean up' });
  await gateway.handleEvent({ type: 'message', bot_id: 'B', channel: 'D1', channel_type: 'im', ts: '1', text: 'x' });
  assert.equal(seen.length, 1);
  const posts = () => http.calls.filter((c) => c.url.endsWith('chat.postMessage'));
  const ask = posts().find((c) => c.body.blocks);
  assert.equal(ask.body.thread_ts, '10.1');
  const actions = ask.body.blocks[1].elements;
  assert.deepEqual(actions.map((a) => a.text.text), ['Allow', 'Reject']);
  // Wrong channel and stranger presses are ignored.
  await gateway.handleInteractive({ type: 'block_actions', user: { id: 'U1' }, channel: { id: 'C9' }, actions: [{ action_id: 'oasis_a', value: actions[0].value }] });
  await gateway.handleInteractive({ type: 'block_actions', user: { id: 'U2' }, channel: { id: 'C1' }, actions: [{ action_id: 'oasis_a', value: actions[0].value }] });
  assert.equal(approved, undefined);
  ws.emit({ envelope_id: 'e2', type: 'interactive', payload: { type: 'block_actions', user: { id: 'U1' }, channel: { id: 'C1' }, container: { message_ts: '11.0' }, message: { text: 'Approval needed' }, actions: [{ action_id: 'oasis_a', value: actions[0].value }] } });
  await flush();
  assert.equal(approved, true);
  assert.match(http.calls.find((c) => c.url.endsWith('chat.update')).body.text, /Allowed by <@U1>/);
  assert.equal(posts().at(-1).body.text, 'ok');
  // A stranger's DM gets their member ID.
  await gateway.handleEvent({ type: 'message', user: 'U7', channel: 'D7', channel_type: 'im', ts: '2', text: 'hi' });
  assert.match(posts().at(-1).body.text, /member ID is U7/);
  assert.equal(posts().at(-1).body.channel, 'D7');
  gateway.stop();
  await closed;
});
