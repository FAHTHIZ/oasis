// A Telegram token the API rejects is reported before routines start, with
// what to do about it, instead of "Routine daemon started" and then
// "Telegram getMe failed: Unauthorized".
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runGateway } from '../src/gateway-telegram.mjs';

test('a rejected Telegram token fails before onReady with a clear message', async () => {
  const root = mkdtempSync(join(tmpdir(), 'oasis-tgcheck-'));
  const env = { HOME: root, OASIS_CONFIG_DIR: join(root, 'cfg'), OASIS_TELEGRAM_BOT_TOKEN: '123456789:AAbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', OASIS_TELEGRAM_ALLOWED_CHATS: '1' };
  const fetchImpl = async () => new Response(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }), { status: 401 });
  let ready = 0;
  await assert.rejects(runGateway(['telegram'], { root, env, fetchImpl, onReady: async () => { ready++; return null; } }), /did not accept the bot token in OASIS_TELEGRAM_BOT_TOKEN.*@BotFather/);
  assert.equal(ready, 0, 'routines must not start for a bad token');
});

// A socket that closes right away with the given code, like Discord does
// after an identify with a bad token.
function closingSocket(code) {
  return class {
    constructor() { this.listeners = {}; setTimeout(() => (this.listeners.close || []).forEach((fn) => fn({ code })), 5); }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    send() {}
    close() {}
  };
}

test('Discord and Slack stop with the token to copy again when it is rejected', async () => {
  const { createDiscordGateway } = await import('../src/gateway-discord.mjs');
  const { createSlackGateway } = await import('../src/gateway-slack.mjs');
  const root = mkdtempSync(join(tmpdir(), 'oasis-tgcheck-'));
  const env = { HOME: root, OASIS_CONFIG_DIR: join(root, 'cfg'), OASIS_DISCORD_BOT_TOKEN: 'x'.repeat(70), OASIS_DISCORD_ALLOWED_USERS: '1', OASIS_SLACK_APP_TOKEN: 'xapp-1', OASIS_SLACK_BOT_TOKEN: 'xoxb-1', OASIS_SLACK_ALLOWED_USERS: 'U1' };
  const discord = createDiscordGateway({ root, env, log: () => {}, WebSocketImpl: closingSocket(4004) });
  await assert.rejects(discord.run(), /Discord did not accept the bot token in OASIS_DISCORD_BOT_TOKEN/);
  discord.stop();
  const intents = createDiscordGateway({ root, env, log: () => {}, WebSocketImpl: closingSocket(4014) });
  await assert.rejects(intents.run(), /Message Content Intent/);
  intents.stop();
  const slack = createSlackGateway({ root, env, log: () => {}, fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: 'invalid_auth' })) });
  await assert.rejects(slack.run(), /^Error: Slack did not accept the token \(invalid_auth\)/);
  slack.stop();
});
