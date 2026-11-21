import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { homeCommand, homeDestination, readHome } from '../src/gateway-home.mjs';
import { deliverOutput, parseDeliver } from '../src/routines.mjs';
import { createChatCore } from '../src/gateway-core.mjs';
import { createTelegramGateway } from '../src/gateway-telegram.mjs';

const envFor = () => ({ OASIS_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'oasis-home-')) });

test('home destinations drop thread parts', () => {
  assert.equal(homeDestination('slack', 'C1:1700.1'), 'C1');
  assert.equal(homeDestination('mattermost', 'chan:root'), 'chan');
  assert.equal(homeDestination('email', 'me@example.com <id@x>'), 'me@example.com');
  assert.equal(homeDestination('matrix', '!room:example.org'), '!room:example.org');
});

test('/sethome and /home through the shared chat core', async () => {
  const env = envFor();
  const sent = [];
  const core = createChatCore({ platform: 'matrix', env, root: process.cwd(), send: async (key, text) => { sent.push(text); }, log: () => {} });
  assert.equal(await core.handleText('!room:m.org', '/home'), undefined);
  assert.match(sent.at(-1), /No home channel/);
  await core.handleText('!room:m.org', '/sethome');
  assert.match(sent.at(-1), /home channel \(matrix:!room:m\.org\)/);
  assert.equal(readHome(env).target, 'matrix:!room:m.org');
  assert.match(homeCommand('/sethome', { platform: 'slack', chatKey: 'C9:1.2', env }), /replaces matrix:!room:m\.org/);
  assert.equal(readHome(env).target, 'slack:C9');
});

test('routines deliver to home', async () => {
  const env = { ...envFor(), OASIS_TELEGRAM_BOT_TOKEN: '1:x', OASIS_TELEGRAM_API_BASE: 'http://tg.test' };
  assert.equal(parseDeliver('home'), 'home');
  await assert.rejects(deliverOutput({ id: 'r1', deliver: 'home' }, 'hi', { env, fetchImpl: async () => new Response('{}') }), /No home channel/);
  const calls = [];
  const gateway = createTelegramGateway({ token: '123456:' + 'a'.repeat(30), allowedChats: new Set(['42']), env, fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return new Response(JSON.stringify({ ok: true, result: true })); }, log: () => {} });
  await gateway.handleUpdate({ update_id: 1, message: { chat: { id: 42 }, text: '/sethome' } });
  assert.match(calls.at(-1).body.text, /telegram:42/);
  const posted = [];
  const result = await deliverOutput({ id: 'r1', deliver: 'home' }, 'report', { env, fetchImpl: async (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return new Response('{}'); } });
  assert.equal(result.delivered, 'telegram:42');
  assert.equal(posted[0].url, 'http://tg.test/bot1:x/sendMessage');
  assert.equal(posted[0].body.chat_id, '42');
});
