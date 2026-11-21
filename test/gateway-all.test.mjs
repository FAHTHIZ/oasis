import test from 'node:test';
import assert from 'node:assert/strict';
import { createAllGateways, GATEWAY_PLATFORMS, GATEWAY_TRIGGERS, GATEWAY_USAGE } from '../src/gateway-telegram.mjs';

const deps = { agent: { createSession: async () => ({ messages: [] }), runAgentTurn: async () => ({ text: '' }) }, config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) } };

test('every platform has a trigger variable and appears in the usage text', () => {
  for (const kind of GATEWAY_PLATFORMS) {
    assert.ok(GATEWAY_TRIGGERS[kind], kind);
    assert.match(GATEWAY_USAGE, new RegExp(GATEWAY_TRIGGERS[kind]));
  }
  assert.match(GATEWAY_USAGE, /\|all/);
});

test('gateway all refuses to start with nothing configured', async () => {
  await assert.rejects(() => createAllGateways({ env: {}, log: () => {} }), /no configured platform/);
});

test('gateway all names the half-configured platform', async () => {
  await assert.rejects(() => createAllGateways({ env: { OASIS_WHATSAPP_TOKEN: 't' }, log: () => {} }), /^Error: whatsapp: Set OASIS_WHATSAPP_PHONE_NUMBER_ID/);
});

test('gateway all starts every configured platform, survives one failing and stops them all', async () => {
  const env = {
    OASIS_WHATSAPP_TOKEN: 't', OASIS_WHATSAPP_PHONE_NUMBER_ID: '1234567', OASIS_WHATSAPP_APP_SECRET: 's', OASIS_WHATSAPP_VERIFY_TOKEN: 'verify-me-please', OASIS_WHATSAPP_ALLOWED_USERS: '+15551112222', OASIS_WHATSAPP_PORT: '0',
    OASIS_SIGNAL_API_URL: 'http://127.0.0.1:1', OASIS_SIGNAL_NUMBER: '+15550001111', OASIS_SIGNAL_ALLOWED_USERS: '+15551112222', OASIS_SIGNAL_MODE: 'normal'
  };
  const lines = [];
  const fetchImpl = async () => { throw new Error('offline'); };
  const all = await createAllGateways({ env, deps, fetchImpl, log: (line) => lines.push(line) });
  assert.deepEqual(all.kinds, ['signal', 'whatsapp']);
  const running = all.run();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(lines.some((line) => /Answering on signal, whatsapp/.test(line)));
  const wa = all.gateways.find((g) => g.kind === 'whatsapp').gateway;
  assert.ok(wa.server && wa.server.listening, 'whatsapp webhook keeps serving while signal cannot connect');
  all.stop();
  await running;
});
