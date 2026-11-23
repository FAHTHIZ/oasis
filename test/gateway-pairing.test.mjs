import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPairing, newPairingCode, pairingCommand, pairingEnabled, pairingFile, strangerMessage, withPairing } from '../src/gateway-pairing.mjs';
import { createTelegramGateway, runGateway } from '../src/gateway-telegram.mjs';

const root = () => mkdtempSync(join(tmpdir(), 'oasis-pairing-'));

test('codes are readable and pairing can be switched off', () => {
  for (let i = 0; i < 50; i++) assert.match(newPairingCode(), /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  assert.equal(pairingEnabled({}), true);
  assert.equal(pairingEnabled({ OASIS_GATEWAY_PAIRING: '0' }), false);
  const off = createPairing({ platform: 'slack', root: root(), env: { OASIS_GATEWAY_PAIRING: '0' } });
  assert.equal(off.request('U1'), null);
  assert.match(strangerMessage({ pairing: off, id: 'U1', idName: 'Slack member ID', envName: 'OASIS_SLACK_ALLOWED_USERS' }), /add it to OASIS_SLACK_ALLOWED_USERS/);
});

test('a stranger gets a code, the owner approves it, and unpair revokes it', () => {
  const dir = root();
  let time = 1_000_000;
  const logs = [];
  const pairing = createPairing({ platform: 'discord', root: dir, env: {}, now: () => time, log: (line) => logs.push(line) });
  const allowed = withPairing(new Set(['owner']), pairing);
  assert.equal(allowed.has('owner'), true);
  assert.equal(allowed.has('42'), false);
  assert.equal(allowed.size, 1);
  const text = strangerMessage({ pairing, id: '42', label: '@eve', idName: 'Discord user ID', envName: 'X' });
  const code = text.match(/oasis gateway pair ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  assert.match(text, /@eve \(42\)/);
  assert.equal(pairing.request('42'), code, 'the same person keeps the same code');
  assert.match(logs[0], new RegExp('discord:42.*' + code));
  assert.equal((statSync(pairingFile(dir)).mode & 0o777), 0o600);
  assert.match(pairingCommand(['paired'], { root: dir, now: () => time }), new RegExp(code + '  discord:42'));
  assert.throws(() => pairingCommand(['pair', 'ZZZZ-ZZZZ'], { root: dir, now: () => time }), /No pending/);
  assert.match(pairingCommand(['pair', code.toLowerCase().replace('-', '')], { root: dir, now: () => time }), /Paired discord:42/);
  assert.equal(allowed.has('42'), true);
  assert.deepEqual([...allowed], ['owner']);
  assert.ok(JSON.parse(readFileSync(pairingFile(dir), 'utf8')).paired['discord:42']);
  assert.match(pairingCommand(['unpair', 'discord:42'], { root: dir }), /Unpaired/);
  assert.equal(allowed.has('42'), false);
  assert.throws(() => pairingCommand(['unpair', 'discord:42'], { root: dir }), /not paired/);
});

test('codes expire after an hour and are scoped to their platform', () => {
  const dir = root();
  let time = 5_000_000;
  const tg = createPairing({ platform: 'telegram', root: dir, env: {}, now: () => time });
  const code = tg.request('7');
  time += 61 * 60 * 1000;
  assert.throws(() => pairingCommand(['pair', code], { root: dir, now: () => time }), /expire/);
  const fresh = tg.request('7');
  assert.notEqual(fresh, code);
  pairingCommand(['pair', fresh], { root: dir, now: () => time });
  assert.equal(tg.isPaired('7'), true);
  assert.equal(createPairing({ platform: 'slack', root: dir, env: {} }).isPaired('7'), false);
});

test('a gateway with no allowlist starts in pairing mode and lets paired chats in', async () => {
  const dir = root();
  const sent = [];
  const fetchImpl = async (url, init) => { sent.push(JSON.parse(init.body || '{}')); return new Response(JSON.stringify({ ok: true, result: [] })); };
  let turns = 0;
  const deps = { agent: { createSession: async () => ({ messages: [], config: { model: 'm' }, permissions: { mode: 'default', setMode(mode) { this.mode = mode; } } }), runAgentTurn: async () => { turns++; return { text: 'hi' }; } }, config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) } };
  const gateway = createTelegramGateway({ token: '123456:' + 'a'.repeat(35), env: {}, root: dir, fetchImpl, deps, log: () => {} });
  const msg = (text) => ({ update_id: Math.random(), message: { message_id: 1, chat: { id: 9, type: 'private' }, from: { id: 9, username: 'sam' }, text } });
  await gateway.handleUpdate(msg('hello'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(turns, 0);
  const code = sent.map((body) => body.text || '').join('\n').match(/pair ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  let out = '';
  await runGateway(['pair', code], { root: dir, stdout: { write: (text) => { out += text; } } });
  assert.match(out, /Paired telegram:9 \(@sam\)/);
  await gateway.handleUpdate(msg('hello again'));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(turns, 1);
  assert.throws(() => createTelegramGateway({ token: '123456:' + 'a'.repeat(35), env: { OASIS_GATEWAY_PAIRING: '0' }, root: dir }), /ALLOWED_CHATS/);
});

test('pairings planted inside the workspace are not trusted', async () => {
  const { mkdirSync, writeFileSync, realpathSync } = await import('node:fs');
  const dir = root();
  const configDir = mkdtempSync(join(tmpdir(), 'oasis-pairing-config-'));
  const env = { OASIS_CONFIG_DIR: configDir };
  // What a cloned repository (or a model's write_file) could put there.
  mkdirSync(join(dir, '.oasis', 'gateway'), { recursive: true });
  writeFileSync(join(dir, '.oasis', 'gateway', 'pairing.json'), JSON.stringify({ paired: { 'telegram:666': { label: 'attacker' } }, pending: {} }));
  const pairing = createPairing({ platform: 'telegram', root: dir, env });
  assert.equal(pairing.isPaired('666'), false);
  assert.equal(withPairing(new Set(), pairing).has('666'), false);
  const file = pairingFile(dir, env);
  assert.ok(file.startsWith(realpathSync(configDir) + '/') || file.startsWith(configDir + '/'), file);
  assert.ok(!file.startsWith(dir), 'approvals are kept outside the workspace');
  assert.match(pairingCommand(['paired'], { root: dir, env }), /Not active: telegram:666/);
  const code = pairing.request('7');
  pairingCommand(['pair', code], { root: dir, env });
  assert.equal(pairing.isPaired('7'), true);
  assert.equal(createPairing({ platform: 'telegram', root: root(), env }).isPaired('7'), false, 'pairings stay per workspace');
});
