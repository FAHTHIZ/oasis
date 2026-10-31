import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchPublicUrl } from '../src/public-fetch.mjs';
import { isNonPublicIpAddress } from '../src/network-safety.mjs';

const neverRequest = async () => { throw new Error('network request must not happen'); };
const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

async function blocked(url, lookupImpl = publicLookup) {
  await assert.rejects(fetchPublicUrl(url, { lookupImpl, requestImpl: neverRequest }), (error) => {
    assert.doesNotMatch(error.message, /network request must not happen/, url + ' reached the network');
    return true;
  }, url);
}

test('alternate IPv4 spellings of loopback/metadata are normalized and blocked', async () => {
  for (const url of [
    'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0x7f.0.0.1/',
    'http://169.254.169.254/latest/meta-data/', 'http://2852039166/', 'http://0.0.0.0/', 'http://[::]/',
    'http://100.64.0.1/', 'http://198.18.0.1/', 'http://255.255.255.255/'
  ]) await blocked(url);
});

test('IPv4-mapped, NAT64 and other IPv6 encodings inherit the IPv4 policy', async () => {
  for (const url of [
    'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/', 'http://[0:0:0:0:0:ffff:a9fe:a9fe]/',
    'http://[64:ff9b::a9fe:a9fe]/', 'http://[64:ff9b:1::1]/', 'http://[::1]/', 'http://[fe80::1]/',
    'http://[fd00::1]/', 'http://[2001:db8::1]/', 'http://[2002:7f00:1::]/', 'http://[ff02::1]/'
  ]) await blocked(url);
  assert.equal(isNonPublicIpAddress('::ffff:8.8.8.8'), false);
  assert.equal(isNonPublicIpAddress('2606:4700:4700::1111'), false);
  assert.equal(isNonPublicIpAddress('fe80::1%eth0'), true);
  assert.equal(isNonPublicIpAddress('not-an-ip'), false);
});

test('local hostnames, trailing dots and metadata names are blocked before DNS', async () => {
  const noLookup = async () => { throw new Error('DNS must not be consulted'); };
  for (const url of [
    'http://localhost/', 'http://localhost./', 'http://LOCALHOST../', 'http://api.localhost/', 'http://printer.local./',
    'http://metadata.google.internal/', 'http://metadata.google.internal./computeMetadata/v1/', 'http://foo.corp.internal/'
  ]) {
    await assert.rejects(fetchPublicUrl(url, { lookupImpl: noLookup, requestImpl: neverRequest }), /Local and metadata URLs are blocked/, url);
  }
});

test('a DNS answer set containing any private address is rejected (no partial trust)', async () => {
  await blocked('http://rebind.example/', async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }]);
  await blocked('http://rebind6.example/', async () => [{ address: '2606:4700::1', family: 6 }, { address: '::ffff:192.168.1.1', family: 6 }]);
  await blocked('http://empty.example/', async () => []);
  await assert.rejects(fetchPublicUrl('http://nxdomain.example/', { lookupImpl: async () => { throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' }); }, requestImpl: neverRequest }), /Could not resolve/);
});

test('non-HTTP schemes and embedded credentials are refused', async () => {
  for (const url of ['file:///etc/passwd', 'data:text/plain,hi', 'ftp://example.com/', 'javascript:alert(1)', 'gopher://example.com/', 'http://user:pass@example.com/', 'http://user@example.com/', 'not a url']) {
    await blocked(url);
  }
});

test('redirects are reported, never followed, and validated DNS answers are pinned', async () => {
  let seen;
  const requestImpl = async (url, addresses) => { seen = addresses; return { status: 302, headers: new Map([['location', 'http://169.254.169.254/']]), body: '' }; };
  const result = await fetchPublicUrl('http://example.com/start', { lookupImpl: publicLookup, requestImpl });
  assert.equal(result.status, 302);
  assert.equal(result.redirect, 'http://169.254.169.254/');
  assert.match(result.message, /not followed/);
  assert.deepEqual(seen, [{ address: '93.184.216.34', family: 4 }]);
});

test('provider/network failures surface as errors without leaking a partial result', async () => {
  await assert.rejects(fetchPublicUrl('http://example.com/', { lookupImpl: publicLookup, requestImpl: async () => { throw new Error('ECONNRESET'); } }), /ECONNRESET/);
  const notOk = await fetchPublicUrl('http://example.com/', { lookupImpl: publicLookup, requestImpl: async () => ({ status: 503, headers: new Map(), body: 'down' }) });
  assert.equal(notOk.status, 503);
  assert.match(notOk.error, /unsuccessful/);
  const binary = await fetchPublicUrl('http://example.com/', { lookupImpl: publicLookup, requestImpl: async () => ({ status: 200, headers: new Map([['content-type', 'application/octet-stream']]), body: 'x' }) });
  assert.match(binary.error, /not an accepted text content type/);
  const huge = await fetchPublicUrl('http://example.com/', { lookupImpl: publicLookup, requestImpl: async () => ({ tooLarge: true }) });
  assert.match(huge.error, /1 MiB/);
});
