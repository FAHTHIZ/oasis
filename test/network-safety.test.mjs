import test from 'node:test';
import assert from 'node:assert/strict';
import { isNonPublicIpAddress } from '../src/network-safety.mjs';

test('public unicast addresses are allowed', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4001::200e', '[2001:4860:4860::8888]']) {
    assert.equal(isNonPublicIpAddress(address), false, address);
  }
});

test('private, loopback, link-local, metadata and special-purpose addresses are blocked', () => {
  for (const address of [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1',
    '192.0.2.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255', '192.88.99.1',
    '::', '::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456::1', 'ff02::1', '2001:db8::1', '2002:c000:0204::1',
    '3fff::1', '2001::1', '64:ff9b:1::1', '4000::1', '1::1'
  ]) assert.equal(isNonPublicIpAddress(address), true, address);
});

test('IPv4 embedded in IPv6 inherits the IPv4 policy', () => {
  assert.equal(isNonPublicIpAddress('::ffff:127.0.0.1'), true);
  assert.equal(isNonPublicIpAddress('::ffff:7f00:1'), true);
  assert.equal(isNonPublicIpAddress('::ffff:8.8.8.8'), false);
  assert.equal(isNonPublicIpAddress('64:ff9b::10.0.0.1'), true);
  assert.equal(isNonPublicIpAddress('64:ff9b::8.8.8.8'), false);
});

test('deprecated IPv4-compatible ::a.b.c.d is not mistaken for IPv4-mapped', () => {
  // ipaddr.js parses "::8.8.8.8" as "::ffff:8.8.8.8"; the policy must still block it.
  assert.equal(isNonPublicIpAddress('::8.8.8.8'), true);
});

test('hostnames are not IP literals and malformed IPv6 fails closed', () => {
  assert.equal(isNonPublicIpAddress('example.com'), false);
  assert.equal(isNonPublicIpAddress('2130706433'), false, 'inet_aton integer spellings are hostnames here, not IPs');
  assert.equal(isNonPublicIpAddress('1:2:3:4:5:6:7:8:9'), true);
});
