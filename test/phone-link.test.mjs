import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPhoneLink, phoneNetworks, phoneUrl, qrSvg } from '../src/phone-link.mjs';
import { encodeQr } from '../src/qr.mjs';
import { startOasisWebServer } from '../src/web.mjs';

const ifaces = {
  lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
  wlan0: [{ address: '192.168.1.20', family: 'IPv4', internal: false }],
  tailscale0: [{ address: '100.101.102.103', family: 'IPv4', internal: false }],
  docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false }]
};

test('phoneNetworks separates Tailscale from Wi-Fi and drops virtual adapters', () => {
  const n = phoneNetworks(ifaces);
  assert.deepEqual(n.tailscale.map((e) => e.address), ['100.101.102.103']);
  assert.deepEqual(n.lan.map((e) => e.address), ['192.168.1.20']);
});

test('phoneUrl carries the token in the fragment, never the query', () => {
  assert.equal(phoneUrl({ address: '192.168.1.20', port: 4000, token: 'a b' }), 'http://192.168.1.20:4000/#token=a%20b');
  assert.equal(phoneUrl({ address: 'fd00::1', port: 1, token: '' }), 'http://[fd00::1]:1/');
});

test('qrSvg draws exactly the dark modules of the QR matrix', () => {
  const text = 'http://100.101.102.103:41234/#token=abcdefghijklmnopqrstuvwxyz0123456789';
  const { size, modules } = encodeQr(text, { ecl: 'M' });
  const svg = qrSvg(text);
  assert.match(svg, new RegExp('viewBox="0 0 ' + (size + 8) + ' ' + (size + 8) + '"'));
  let dark = 0; for (const row of modules) for (const cell of row) if (cell) dark += 1;
  const drawn = [...svg.matchAll(/h(\d+)v1/g)].reduce((sum, m) => sum + Number(m[1]), 0);
  assert.equal(drawn, dark);
  assert.doesNotMatch(svg, /<script|on\w+=/i);
});

test('a phone link forwards to the same server, refuses unconfirmed Wi-Fi, and stop disconnects phones', async () => {
  const server = createServer((req, res) => { res.setHeader('connection', 'keep-alive'); res.end('same-server'); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const link = createPhoneLink({ server, token: 'tok' }, { interfaces: ifaces, resolveBindAddress: () => '127.0.0.1' });
  try {
    assert.equal(link.status().active, false);
    assert.equal(link.status().tailscaleAvailable, true);
    await assert.rejects(link.start({ network: 'lan' }), /unencrypted/i);
    const st = await link.start({ network: 'tailscale' });
    assert.equal(st.active, true); assert.equal(st.encrypted, true);
    assert.match(st.urls[0], /^http:\/\/100\.101\.102\.103:\d+\/#token=tok$/);
    assert.match(st.qr, /^<svg/);
    const port = Number(new URL(st.urls[0]).port);
    const body = await (await fetch('http://127.0.0.1:' + port + '/')).text();
    assert.equal(body, 'same-server');
    const lan = await link.start({ network: 'lan', allowUnencrypted: true });
    assert.equal(lan.network, 'lan'); assert.equal(lan.encrypted, false);
    await link.stop();
    assert.equal(link.status().active, false);
    await assert.rejects(fetch('http://127.0.0.1:' + Number(new URL(lan.urls[0]).port) + '/'));
  } finally {
    await link.stop();
    server.closeAllConnections?.();
    await new Promise((r) => server.close(r));
  }
});

test('a phone link reports a clear error when Tailscale is not connected', async () => {
  const link = createPhoneLink({ server: createServer(), token: 't' }, { interfaces: { wlan0: ifaces.wlan0 } });
  await assert.rejects(link.start({ network: 'tailscale' }), /Tailscale is not connected/);
});

test('/api/phone/link reports networks, needs Wi-Fi consent, and the desktop native dialog decides', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-phone-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'cfg') };
  let asked = 0;
  const calls = [];
  const fakeLink = {
    status: () => ({ active: false, tailscaleAvailable: false, lanAvailable: true }),
    start: async (args) => { calls.push(args); return { active: true, network: args.network, urls: ['http://192.168.1.20:5/#token=x'] }; },
    stop: async () => ({ active: false })
  };
  const cli = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'phone-test-token-0123456789', phoneLink: fakeLink });
  const desktop = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'phone-test-token-0123456789', phoneLink: fakeLink, confirmUnencryptedPhoneLink: async () => { asked += 1; return asked > 1; } });
  const call = (app, method, body) => fetch('http://127.0.0.1:' + app.port + '/api/phone/link', { method, headers: { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  try {
    const st = await (await call(cli, 'GET')).json();
    assert.equal(st.mode, 'link'); assert.equal(st.lanAvailable, true); assert.equal(st.nativeConfirm, false);
    assert.equal((await call(cli, 'POST', { action: 'start', network: 'lan' })).status, 409);
    assert.equal(calls.length, 0);
    assert.equal((await call(cli, 'POST', { action: 'start', network: 'lan', allowUnencrypted: true })).status, 200);
    assert.deepEqual(calls.at(-1), { network: 'lan', allowUnencrypted: true });
    assert.equal((await (await call(desktop, 'GET')).json()).nativeConfirm, true);
    // The page cannot bypass the native dialog by claiming consent.
    assert.equal((await call(desktop, 'POST', { action: 'start', network: 'lan', allowUnencrypted: true })).status, 409);
    assert.equal(calls.length, 1);
    assert.equal((await call(desktop, 'POST', { action: 'start', network: 'lan' })).status, 200);
    assert.equal(asked, 2);
    assert.equal((await call(cli, 'POST', { action: 'nope' })).status, 400);
    assert.equal((await fetch('http://127.0.0.1:' + cli.port + '/api/phone/link')).status, 401);
  } finally {
    await cli.close(); await desktop.close();
    await rm(root, { recursive: true, force: true });
  }
});
