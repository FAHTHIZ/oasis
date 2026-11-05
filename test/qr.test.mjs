import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encodeQr, renderQrTerminal } from '../src/qr.mjs';

const fingerprint = (qr) => createHash('sha256').update(qr.modules.map((row) => row.map((b) => (b ? 1 : 0)).join('')).join('\n')).digest('hex');

// Reference fingerprints from the python-qrcode library (byte mode, level M,
// same mask), so these lock the encoder to an independent implementation.
test('matrices match an independent QR implementation', () => {
  const link = encodeQr('https://192.168.1.20:4317/#token=8f3a9c2e7b6d4f1a0c9e8d7b6a5f4e3d2c1b0a9f8e7d6c5b', { mask: 2 });
  assert.equal(link.version, 5);
  assert.equal(fingerprint(link), '9e055c978062eba786b5bdd3c43118562d1ac44e0a8250156c728ea3301ffd2e');
  const long = encodeQr('x'.repeat(300), { mask: 0 });
  assert.equal(long.version, 13, 'version 7+ includes the version information blocks');
  assert.equal(fingerprint(long), 'a6c4c99a50e77d18b6ddfdcbd85fffbd3b4da81e4eabc96b030a3f559d2b7fbb');
});

test('finder patterns, timing and sizes follow the standard', () => {
  const qr = encodeQr('hello');
  assert.equal(qr.size, 21);
  const row0 = qr.modules[0].slice(0, 7).map(Boolean);
  assert.deepEqual(row0, [true, true, true, true, true, true, true]);
  assert.equal(qr.modules[6][8], true, 'timing pattern starts dark');
  assert.equal(qr.modules[qr.size - 8][8], true, 'the fixed dark module');
  assert.ok(qr.mask >= 0 && qr.mask < 8);
  assert.throws(() => encodeQr('x'.repeat(5000)), /too long/);
});

test('terminal rendering packs two rows per line with a quiet zone', () => {
  const plain = renderQrTerminal('hello', { color: false });
  const lines = plain.split('\n');
  assert.equal(lines.length, Math.ceil((21 + 4) / 2));
  assert.ok(lines.every((line) => [...line].length === 25));
  assert.match(lines[0], /^█+$/, 'the quiet zone is light');
  assert.match(renderQrTerminal('hello'), /\x1b\[97;40m/);
});

test('LAN addresses keep private ranges and list real adapters first', async () => {
  const { lanAddresses, isPrivateIPv4 } = await import('../src/lan-addresses.mjs');
  assert.equal(isPrivateIPv4('192.168.1.4'), true);
  assert.equal(isPrivateIPv4('172.20.0.1'), true);
  assert.equal(isPrivateIPv4('100.101.2.3'), true);
  assert.equal(isPrivateIPv4('8.8.8.8'), false);
  assert.equal(isPrivateIPv4('172.32.0.1'), false);
  const list = lanAddresses({
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    tailscale0: [{ family: 'IPv4', address: '100.88.1.2', internal: false }],
    wlan0: [{ family: 4, address: '192.168.1.42', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    eth1: [{ family: 'IPv4', address: '203.0.113.9', internal: false }]
  });
  assert.deepEqual(list.map((e) => e.address), ['192.168.1.42', '100.88.1.2', '172.17.0.1']);
});
