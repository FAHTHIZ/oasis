import test from 'node:test';
import assert from 'node:assert/strict';
import { createSignalGateway, deliverSignal, parseSignalEnvelope, signalGroupRecipient } from '../src/gateway-signal.mjs';
import { parseDeliver, deliverOutput } from '../src/routines.mjs';
import { mkdtempSync as pairMkdtemp } from 'node:fs';
import { tmpdir as pairTmpdir } from 'node:os';
import { join as pairJoin } from 'node:path';
const PAIR_ROOT = pairMkdtemp(pairJoin(pairTmpdir(), 'oasis-pair-'));

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));
const BOT = '+15550000000';
const ME = '+15551112222';

function fakeAgent(onTurn) {
  return {
    createSession: async () => ({ messages: [], config: { model: 'm' }, permissions: { mode: 'default' } }),
    runAgentTurn: async (session, text, options) => onTurn(session, text, options)
  };
}
const deps = (agent) => ({ agent, config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) } });

function fakeApi(handlers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const parsed = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ path: parsed.pathname, search: parsed.search, method: init.method || 'GET', body });
    for (const [pattern, respond] of Object.entries(handlers)) if (parsed.pathname.includes(pattern)) { const out = respond(parsed, body); return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 }); }
    return new Response(JSON.stringify({}), { status: 201 });
  };
  return { calls, fetchImpl };
}

const dm = (text, source = ME, extra = {}) => ({ envelope: { source, sourceNumber: source, sourceUuid: 'uuid-' + source, timestamp: 1, dataMessage: { message: text, ...extra } }, account: BOT });

test('envelope parsing: groups, mentions, own messages', () => {
  assert.equal(signalGroupRecipient('abc='), 'group.' + Buffer.from('abc=').toString('base64'));
  const parsed = parseSignalEnvelope(dm('hi'), BOT);
  assert.equal(parsed.chatKey, ME);
  assert.equal(parsed.text, 'hi');
  assert.equal(parseSignalEnvelope(dm('echo', BOT), BOT), null);
  assert.equal(parseSignalEnvelope({ envelope: { source: ME, receiptMessage: {} } }, BOT), null);
  const group = parseSignalEnvelope(dm('\uFFFC run tests', ME, { groupInfo: { groupId: 'G1==' }, mentions: [{ number: BOT, start: 0, length: 1 }] }), BOT);
  assert.equal(group.group, true);
  assert.equal(group.mentioned, true);
  assert.equal(group.text, 'run tests');
  assert.equal(group.chatKey, signalGroupRecipient('G1=='));
});

test('signal requires API URL, number and allowlist', () => {
  assert.throws(() => createSignalGateway({ env: {} }), /OASIS_SIGNAL_API_URL/);
  assert.throws(() => createSignalGateway({ env: { OASIS_SIGNAL_API_URL: 'http://127.0.0.1:8080', OASIS_SIGNAL_NUMBER: '5551' } }), /OASIS_SIGNAL_NUMBER/);
  assert.throws(() => createSignalGateway({ env: { OASIS_GATEWAY_PAIRING: '0', OASIS_SIGNAL_API_URL: 'http://127.0.0.1:8080', OASIS_SIGNAL_NUMBER: BOT } }), /ALLOWED_USERS/);
});

test('signal polling: strangers told once, allowed DM runs, typed approval, group needs mention', async () => {
  const queue = [[dm('hello', '+15559999999'), dm('again', '+15559999999'), dm('fix the bug'), dm('group chatter', ME, { groupInfo: { groupId: 'G' } })]];
  const api = fakeApi({ '/v1/receive/': () => queue.shift() || [] });
  let approved;
  const turns = [];
  const agent = fakeAgent(async (_s, text, options) => { turns.push(text); approved = await options.approval('Run npm test?', false, {}); return { text: 'fixed' }; });
  const gateway = createSignalGateway({ apiUrl: 'http://127.0.0.1:8080', number: BOT, allowedUsers: new Set([ME]), mode: 'normal', fetchImpl: api.fetchImpl, deps: deps(agent), transcribe: null, root: PAIR_ROOT, log: () => {} });
  assert.equal(await gateway.pollOnce(1), 4);
  await flush();
  assert.equal(api.calls[0].path, '/v1/receive/' + encodeURIComponent(BOT));
  const sends = () => api.calls.filter((c) => c.path === '/v2/send').map((c) => c.body);
  assert.equal(sends().filter((b) => /Your Signal ID is \+15559999999/.test(b.message)).length, 1);
  assert.deepEqual(turns, ['fix the bug']);
  const ask = sends().find((b) => /Approval needed/.test(b.message));
  assert.deepEqual(ask.recipients, [ME]);
  assert.equal(ask.number, BOT);
  assert.match(ask.message, /allow 1/);
  await gateway.handleEnvelope(dm('yes'));
  await flush();
  assert.equal(approved, true);
  assert.ok(sends().some((b) => b.message === 'fixed'));
});

test('signal downloads attachments by id', async () => {
  const api = fakeApi({ '/v1/attachments/': () => new Response(Buffer.from('%PDF-1.4'), { status: 200 }) });
  const os = await import('node:os'); const fs = await import('node:fs/promises'); const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oasis-signal-'));
  const seen = [];
  const agent = fakeAgent(async (_s, text) => { seen.push(text); return { text: 'ok' }; });
  const gateway = createSignalGateway({ root, apiUrl: 'http://127.0.0.1:8080', number: BOT, allowedUsers: new Set(['uuid-' + ME]), fetchImpl: api.fetchImpl, deps: deps(agent), transcribe: null, log: () => {} });
  await gateway.handleEnvelope(dm('summarise this', ME, { attachments: [{ id: 'att123.pdf', contentType: 'application/pdf', filename: 'report.pdf', size: 8 }, { id: '../etc/passwd' }] }));
  await flush();
  assert.ok(api.calls.some((c) => c.path === '/v1/attachments/att123.pdf'));
  assert.ok(!api.calls.some((c) => c.path.includes('passwd')));
  assert.match(seen[0], /summarise this[\s\S]*report\.pdf/);
  await fs.rm(root, { recursive: true, force: true });
});

test('signal json-rpc WebSocket mode', async () => {
  class FakeSocket { static last; constructor(url) { this.url = url; this.listeners = {}; FakeSocket.last = this; } addEventListener(t, f) { (this.listeners[t] ||= []).push(f); } close() { for (const f of this.listeners.close || []) f({}); } emit(d) { for (const f of this.listeners.message || []) f({ data: JSON.stringify(d) }); } }
  const api = fakeApi();
  const turns = [];
  const agent = fakeAgent(async (_s, text) => { turns.push(text); return { text: 'ok' }; });
  const gateway = createSignalGateway({ apiUrl: 'http://127.0.0.1:8080', number: BOT, allowedUsers: new Set([ME]), WebSocketImpl: FakeSocket, fetchImpl: api.fetchImpl, deps: deps(agent), root: PAIR_ROOT, log: () => {} });
  const done = gateway.connect();
  assert.equal(FakeSocket.last.url, 'ws://127.0.0.1:8080/v1/receive/' + encodeURIComponent(BOT));
  FakeSocket.last.emit(dm('status of CI?'));
  await flush();
  FakeSocket.last.close();
  await done;
  assert.deepEqual(turns, ['status of CI?']);
});

test('signal routine delivery', async () => {
  assert.equal(parseDeliver('signal:+15551112222'), 'signal:+15551112222');
  const api = fakeApi();
  await deliverOutput({ id: 'r1', deliver: 'signal:' + ME }, 'nightly backup ok', { env: { OASIS_SIGNAL_API_URL: 'http://127.0.0.1:8080', OASIS_SIGNAL_NUMBER: BOT }, fetchImpl: api.fetchImpl });
  assert.deepEqual(api.calls[0].body.recipients, [ME]);
  assert.match(api.calls[0].body.message, /nightly backup ok/);
  await assert.rejects(() => deliverSignal(ME, 'x', { env: {} }), /OASIS_SIGNAL_API_URL/);
});
