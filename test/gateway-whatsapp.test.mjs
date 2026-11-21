import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createWhatsAppGateway, deliverWhatsApp, extractWhatsAppMessages, verifySignature } from '../src/gateway-whatsapp.mjs';
import { parseDeliver } from '../src/routines.mjs';
import { mkdtempSync as pairMkdtemp } from 'node:fs';
import { tmpdir as pairTmpdir } from 'node:os';
import { join as pairJoin } from 'node:path';
const PAIR_ROOT = pairMkdtemp(pairJoin(pairTmpdir(), 'oasis-pair-'));

const flush = () => new Promise((resolve) => setTimeout(resolve, 30));
const SECRET = 'app-secret-123';
const ME = '15551112222';

function fakeAgent(onTurn) {
  return {
    createSession: async () => ({ messages: [], config: { model: 'm' }, permissions: { mode: 'default' } }),
    runAgentTurn: async (session, text, options) => onTurn(session, text, options)
  };
}
const deps = (agent) => ({ agent, config: { loadConfig: async () => ({ configured: true }) }, sessions: { saveSession: async () => ({}) } });
function fakeGraph(handlers = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, body, headers: init.headers });
    for (const [pattern, respond] of Object.entries(handlers)) if (url.includes(pattern)) { const out = respond(url, body); return out instanceof Response ? out : new Response(JSON.stringify(out), { status: 200 }); }
    return new Response(JSON.stringify({ messages: [{ id: 'wamid.out' }] }), { status: 200 });
  };
  return { calls, fetchImpl };
}
const payload = (messages, phoneNumberId = '1234567') => ({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { metadata: { phone_number_id: phoneNumberId }, messages } }] }] });
const text = (body, from = ME, id = 'wamid.' + Math.random()) => ({ from, id, type: 'text', text: { body } });

function makeGateway(agent, graph) {
  return createWhatsAppGateway({ token: 'EAAG-token', phoneNumberId: '1234567', appSecret: SECRET, verifyToken: 'verify-me-please', allowedUsers: new Set([ME]), port: 0, fetchImpl: graph.fetchImpl, deps: deps(agent), transcribe: null, root: PAIR_ROOT, log: () => {} });
}

async function post(port, body, { sign = true, secret = SECRET } = {}) {
  const raw = JSON.stringify(body);
  const headers = { 'content-type': 'application/json' };
  if (sign) headers['x-hub-signature-256'] = 'sha256=' + createHmac('sha256', secret).update(raw).digest('hex');
  return fetch('http://127.0.0.1:' + port + '/webhook', { method: 'POST', headers, body: raw });
}

test('signature, payload parsing and configuration checks', () => {
  const raw = Buffer.from('{"a":1}');
  assert.ok(verifySignature(raw, 'sha256=' + createHmac('sha256', 's').update(raw).digest('hex'), 's'));
  assert.ok(!verifySignature(raw, 'sha256=' + 'a'.repeat(64), 's'));
  assert.ok(!verifySignature(raw, '', 's'));
  const parsed = extractWhatsAppMessages(payload([text('hi'), { from: ME, id: 'b', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'oasis:a:1', title: 'Allow' } } }, { from: ME, id: 'c', type: 'image', image: { id: 'MEDIA1', mime_type: 'image/jpeg', caption: 'what is this' } }]), '1234567');
  assert.equal(parsed[0].text, 'hi');
  assert.equal(parsed[1].buttonId, 'oasis:a:1');
  assert.equal(parsed[2].media.id, 'MEDIA1');
  assert.equal(parsed[2].text, 'what is this');
  assert.equal(extractWhatsAppMessages(payload([text('x')], '999'), '1234567').length, 0, 'other phone numbers are ignored');
  assert.throws(() => createWhatsAppGateway({ env: {} }), /OASIS_WHATSAPP_TOKEN/);
  assert.throws(() => createWhatsAppGateway({ env: { OASIS_WHATSAPP_TOKEN: 't', OASIS_WHATSAPP_PHONE_NUMBER_ID: '1234567', OASIS_WHATSAPP_APP_SECRET: 's' } }), /VERIFY_TOKEN/);
  assert.throws(() => createWhatsAppGateway({ env: { OASIS_GATEWAY_PAIRING: '0', OASIS_WHATSAPP_TOKEN: 't', OASIS_WHATSAPP_PHONE_NUMBER_ID: '1234567', OASIS_WHATSAPP_APP_SECRET: 's', OASIS_WHATSAPP_VERIFY_TOKEN: 'verify-me' } }), /ALLOWED_USERS/);
});

test('webhook: verification handshake, unsigned calls rejected, a task runs and buttons answer approvals', async () => {
  const graph = fakeGraph();
  let approved;
  const turns = [];
  const agent = fakeAgent(async (_s, body, options) => { turns.push(body); approved = await options.approval('Run npm test?', false, { suggestion: 'Bash(npm test)' }); return { text: 'all green' }; });
  const gateway = makeGateway(agent, graph);
  const running = gateway.run();
  await flush();
  const port = gateway.server.address().port;
  try {
    const ok = await fetch('http://127.0.0.1:' + port + '/webhook?hub.mode=subscribe&hub.verify_token=verify-me-please&hub.challenge=42');
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), '42');
    assert.equal((await fetch('http://127.0.0.1:' + port + '/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42')).status, 403);
    assert.equal((await post(port, payload([text('run tests')]), { sign: false })).status, 401);
    assert.equal((await post(port, payload([text('run tests')]), { secret: 'forged' })).status, 401);
    assert.equal(turns.length, 0);
    const same = text('run the tests', ME, 'wamid.dup');
    assert.equal((await post(port, payload([same]))).status, 200);
    await post(port, payload([same])); // Meta retry: processed once
    await flush();
    assert.deepEqual(turns, ['run the tests']);
    const ask = graph.calls.find((c) => c.body && c.body.type === 'interactive');
    assert.equal(ask.body.to, ME);
    const ids = ask.body.interactive.action.buttons.map((b) => b.reply.id);
    assert.deepEqual(ids, ['oasis:a:1', 'oasis:A:1', 'oasis:r:1']);
    await post(port, payload([{ from: ME, id: 'wamid.btn', type: 'interactive', interactive: { type: 'button_reply', button_reply: { id: 'oasis:A:1', title: 'Always' } } }]));
    await flush();
    assert.equal(approved, 'always');
    assert.ok(graph.calls.some((c) => c.body && c.body.text && c.body.text.body === 'all green'));
  } finally { gateway.stop(); await running; }
});

test('strangers are told once; media is downloaded through the Graph API', async () => {
  const graph = fakeGraph({ '/MEDIA1': () => ({ url: 'https://lookaside.fbsbx.com/x' }), 'lookaside.fbsbx.com': () => new Response(Buffer.from('JPEGDATA'), { status: 200 }) });
  const os = await import('node:os'); const fs = await import('node:fs/promises'); const path = await import('node:path');
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'oasis-wa-'));
  const seen = [];
  const agent = fakeAgent(async (_s, body, options) => { seen.push({ body, images: options.images }); return { text: 'a cat' }; });
  const gateway = createWhatsAppGateway({ root, token: 'EAAG-token', phoneNumberId: '1234567', appSecret: SECRET, verifyToken: 'verify-me-please', allowedUsers: new Set([ME]), fetchImpl: graph.fetchImpl, deps: deps(agent), transcribe: null, log: () => {} });
  await gateway.handleMessage({ from: '19998887777', id: 's1', text: 'hi' });
  await gateway.handleMessage({ from: '19998887777', id: 's2', text: 'hi' });
  assert.equal(graph.calls.filter((c) => c.body && /Your WhatsApp number is \+19998887777/.test(c.body.text && c.body.text.body)).length, 1);
  await gateway.handleMessage({ from: ME, id: 'm1', type: 'image', text: 'what is this', media: { id: 'MEDIA1', mime: 'image/jpeg', name: 'image-1.jpg' } });
  await flush();
  assert.equal(seen.length, 1);
  assert.match(seen[0].body, /what is this[\s\S]*image-1\.jpg/);
  assert.equal(seen[0].images.length, 1);
  assert.equal(graph.calls.find((c) => c.url.includes('lookaside')).headers.authorization, 'Bearer EAAG-token');
  await fs.rm(root, { recursive: true, force: true });
});

test('whatsapp routine delivery', async () => {
  assert.equal(parseDeliver('whatsapp:+15551112222'), 'whatsapp:+15551112222');
  const graph = fakeGraph();
  await deliverWhatsApp('+1 555 111 2222', 'report', { env: { OASIS_WHATSAPP_TOKEN: 't', OASIS_WHATSAPP_PHONE_NUMBER_ID: '1234567' }, fetchImpl: graph.fetchImpl });
  assert.equal(graph.calls[0].body.to, ME);
  const expired = fakeGraph({ '/messages': () => new Response(JSON.stringify({ error: { code: 131047, message: 'Re-engagement message' } }), { status: 400 }) });
  await assert.rejects(() => deliverWhatsApp(ME, 'x', { env: { OASIS_WHATSAPP_TOKEN: 't', OASIS_WHATSAPP_PHONE_NUMBER_ID: '1234567' }, fetchImpl: expired.fetchImpl }), /24 hours/);
});
