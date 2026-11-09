import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeAllowedHost, parseAllowedHosts, hostAllowed, requestProtocol, clientAddress,
  loadAccessKey, createAuthLimiter
} from '../src/remote-access.mjs';

function req({ host, origin, remote = '203.0.113.9', encrypted = false, headers = {} }) {
  return { headers: { host, ...(origin ? { origin } : {}), ...headers }, socket: { remoteAddress: remote, encrypted } };
}

test('allowed hosts are normalized from URLs, hosts and wildcards', () => {
  assert.equal(normalizeAllowedHost('https://Oasis.Example.com/app/'), 'oasis.example.com');
  assert.equal(normalizeAllowedHost('oasis.example.com:8443'), 'oasis.example.com');
  assert.equal(normalizeAllowedHost('*.ts.net'), '*.ts.net');
  assert.equal(normalizeAllowedHost('*.com'), '');
  assert.equal(normalizeAllowedHost('bad host'), '');
  assert.deepEqual(parseAllowedHosts('a.example.com, a.example.com,*.ts.net'), ['a.example.com', '*.ts.net']);
});

test('host check keeps DNS-rebinding protection unless a name is allowed', () => {
  assert.equal(hostAllowed(req({ host: '127.0.0.1:3917' })), true);
  assert.equal(hostAllowed(req({ host: 'evil.example:3917' })), false);
  assert.equal(hostAllowed(req({ host: 'oasis.example.com' }), { allowedHosts: ['oasis.example.com'] }), true);
  assert.equal(hostAllowed(req({ host: 'box.tail1.ts.net' }), { allowedHosts: ['*.ts.net'] }), true);
  assert.equal(hostAllowed(req({ host: 'ts.net' }), { allowedHosts: ['*.ts.net'] }), false);
});

test('origin must match the host and protocol', () => {
  const allowedHosts = ['oasis.example.com'];
  assert.equal(hostAllowed(req({ host: 'oasis.example.com', origin: 'https://oasis.example.com', encrypted: true }), { allowedHosts }), true);
  assert.equal(hostAllowed(req({ host: 'oasis.example.com', origin: 'https://evil.example', encrypted: true }), { allowedHosts }), false);
  assert.equal(hostAllowed(req({ host: 'oasis.example.com', origin: 'https://oasis.example.com' }), { allowedHosts }), false);
});

test('proxy headers count only from a trusted proxy on this computer', () => {
  const proxied = { host: '127.0.0.1:3917', headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'oasis.example.com', 'x-forwarded-for': '198.51.100.7' } };
  assert.equal(requestProtocol(req({ ...proxied, remote: '127.0.0.1' }), { trustProxy: true }), 'https:');
  assert.equal(requestProtocol(req({ ...proxied, remote: '127.0.0.1' })), 'http:');
  assert.equal(requestProtocol(req({ ...proxied, remote: '203.0.113.9' }), { trustProxy: true }), 'http:');
  assert.equal(clientAddress(req({ ...proxied, remote: '127.0.0.1' }), { trustProxy: true }), '198.51.100.7');
  assert.equal(clientAddress(req({ ...proxied, remote: '203.0.113.9' }), { trustProxy: true }), '203.0.113.9');
  assert.equal(hostAllowed(req({ ...proxied, remote: '127.0.0.1', origin: 'https://oasis.example.com' }), { trustProxy: true, allowedHosts: ['oasis.example.com'] }), true);
});

test('persistent access key is created owner-only and reused', () => {
  const env = { OASIS_CONFIG_DIR: mkdtempSync(path.join(os.tmpdir(), 'oasis-key-')) };
  const first = loadAccessKey({ env });
  assert.equal(first.created, true);
  assert.ok(first.key.length >= 32);
  if (process.platform !== 'win32') assert.equal(statSync(first.file).mode & 0o077, 0);
  assert.equal(loadAccessKey({ env }).key, first.key);
  const rotated = loadAccessKey({ env, rotate: true });
  assert.notEqual(rotated.key, first.key);
  assert.equal(readFileSync(first.file, 'utf8').trim(), rotated.key);
  assert.throws(() => loadAccessKey({ env: { ...env, OASIS_WEB_TOKEN: 'short' } }), /at least 32/);
  assert.equal(loadAccessKey({ env: { ...env, OASIS_WEB_TOKEN: 'x'.repeat(40) } }).source, 'env');
});

test('auth limiter locks an address after repeated wrong keys', () => {
  let time = 0;
  const limiter = createAuthLimiter({ max: 3, windowMs: 1000, lockMs: 5000, now: () => time });
  assert.equal(limiter.fail('a'), 0);
  assert.equal(limiter.fail('a'), 0);
  assert.equal(limiter.fail('a'), 5);
  assert.equal(limiter.blocked('a'), 5);
  assert.equal(limiter.blocked('b'), 0);
  time = 5001;
  assert.equal(limiter.blocked('a'), 0);
  limiter.fail('a'); limiter.succeed('a');
  assert.equal(limiter.size, 0);
});
