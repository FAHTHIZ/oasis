import test from 'node:test';
import assert from 'node:assert/strict';
import { createTelegramGateway, chunkMessage, parseAllowedChats } from '../src/gateway-telegram.mjs';

const TOKEN = '123456:' + 'A'.repeat(30);

function fakeTelegram() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    assert.ok(url.includes('/bot' + TOKEN + '/'));
    const body = JSON.parse(init.body);
    calls.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result: method === 'getUpdates' ? [] : method === 'getMe' ? { username: 'oasis_bot' } : true }));
  };
  return { calls, fetchImpl, sent: () => calls.filter((call) => call.method === 'sendMessage') };
}

function fakeAgent(onTurn) {
  return {
    createSession: async () => ({ messages: [], config: { model: 'm' }, permissions: { mode: 'default', setMode(mode) { this.mode = mode; } } }),
    runAgentTurn: async (session, text, options) => onTurn(session, text, options)
  };
}

const deps = (agent) => ({ agent, config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) } });
const msg = (chat, text, id = 1) => ({ update_id: id, message: { chat: { id: chat }, text } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

test('requires a token and an allowlist', () => {
  assert.throws(() => createTelegramGateway({ env: {} }), /BOT_TOKEN/);
  assert.throws(() => createTelegramGateway({ env: { OASIS_TELEGRAM_BOT_TOKEN: TOKEN } }), /ALLOWED_CHATS/);
  assert.deepEqual([...parseAllowedChats('42, -1001234 nope')], ['42', '-1001234']);
});

test('unknown chats get their ID once and never reach the agent', async () => {
  const tg = fakeTelegram();
  let turns = 0;
  const gateway = createTelegramGateway({ token: TOKEN, allowedChats: new Set(['42']), fetchImpl: tg.fetchImpl, deps: deps(fakeAgent(() => { turns++; return { text: 'x' }; })), log: () => {} });
  await gateway.handleUpdate(msg(7, 'rm -rf /'));
  await gateway.handleUpdate(msg(7, 'again'));
  await flush();
  assert.equal(turns, 0);
  assert.equal(tg.sent().length, 1);
  assert.match(tg.sent()[0].body.text, /Chat ID: 7/);
});

test('allowed chats run turns, see approval buttons and can approve', async () => {
  const tg = fakeTelegram();
  let approved;
  const agent = fakeAgent(async (_session, text, options) => {
    approved = await options.approval('Run npm test?', false, { suggestion: 'Bash(npm test)' });
    return { text: 'Ran tests for: ' + text };
  });
  const gateway = createTelegramGateway({ token: TOKEN, allowedChats: new Set(['42']), fetchImpl: tg.fetchImpl, deps: deps(agent), log: () => {} });
  await gateway.handleUpdate(msg(42, 'run the tests'));
  await flush();
  const ask = tg.sent().find((call) => /Approval needed/.test(call.body.text));
  const buttons = ask.body.reply_markup.inline_keyboard[0].map((button) => button.text);
  assert.deepEqual(buttons, ['Allow', 'Always', 'Reject']);
  const always = ask.body.reply_markup.inline_keyboard[0][1].callback_data;
  await gateway.handleUpdate({ update_id: 2, callback_query: { id: 'q', data: always, message: { chat: { id: 42 } } } });
  await flush();
  assert.equal(approved, 'always');
  assert.match(tg.sent().at(-1).body.text, /Ran tests for: run the tests/);
});

test('approvals from another chat are ignored; /stop cancels; /mode changes approvals', async () => {
  const tg = fakeTelegram();
  let release;
  const agent = fakeAgent((_session, _text, options) => new Promise((resolve) => {
    release = resolve;
    options.signal.addEventListener('abort', () => resolve({ text: '' }));
    options.approval('Delete build/?', false, {}).then((value) => { agent.answer = value; });
  }));
  const gateway = createTelegramGateway({ token: TOKEN, allowedChats: new Set(['42', '43']), fetchImpl: tg.fetchImpl, deps: deps(agent), log: () => {} });
  await gateway.handleUpdate(msg(42, 'clean up'));
  await flush();
  const id = [...gateway.approvals.keys()][0];
  await gateway.handleUpdate({ update_id: 3, callback_query: { id: 'q', data: 'a:' + id, message: { chat: { id: 43 } } } });
  assert.ok(gateway.approvals.has(id), 'other chat cannot approve');
  await gateway.handleUpdate(msg(42, '/stop'));
  await flush();
  assert.equal(agent.answer, false);
  assert.match(tg.sent().at(-1).body.text, /Stopped/);
  await gateway.handleUpdate(msg(42, '/mode plan'));
  assert.equal(gateway.chats.get('42').session.permissions.mode, 'plan');
  assert.equal(typeof release, 'function');
});

test('long replies are split under the Telegram limit', () => {
  const parts = chunkMessage(('line\n').repeat(2000));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((part) => part.length <= 4000));
});
