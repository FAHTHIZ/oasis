import test from 'node:test';
import assert from 'node:assert/strict';
import { isPrivateIPv4, lanAddresses } from '../src/lan-addresses.mjs';

test('only private and Tailscale IPv4 ranges count as LAN addresses', () => {
  for (const address of ['10.0.0.4', '172.16.1.1', '172.31.255.255', '192.168.1.20', '100.64.0.1', '100.127.255.254']) assert.equal(isPrivateIPv4(address), true, address);
  for (const address of ['8.8.8.8', '172.15.0.1', '172.32.0.1', '100.63.0.1', '100.128.0.1', '127.0.0.1', '192.168.1', '256.1.1.1', 'fe80::1', '']) assert.equal(isPrivateIPv4(address), false, address);
});

test('LAN links list real interfaces first, then Tailscale, then VM and Docker bridges', () => {
  const found = lanAddresses({
    docker0: [{ family: 'IPv4', address: '172.17.0.1', internal: false }],
    tailscale0: [{ family: 'IPv4', address: '100.101.1.2', internal: false }],
    lo: [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
    eth0: [{ family: 4, address: '192.168.1.20', internal: false }, { family: 'IPv6', address: 'fe80::1', internal: false }],
    wan: [{ family: 'IPv4', address: '203.0.113.7', internal: false }]
  });
  assert.deepEqual(found.map((item) => item.address), ['192.168.1.20', '100.101.1.2', '172.17.0.1']);
  assert.equal(found[1].tailscale, true);
  assert.equal(found[2].virtual, true);
  assert.deepEqual(lanAddresses(null), []);
});
