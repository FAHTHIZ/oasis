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
