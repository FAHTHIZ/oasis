import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  isBlockedAddress, isLocalHostname, normalizeHostname, pinnedRequest, readBoundedBody, resolvePublicAddresses
} from '../src/safe-http.mjs';

test('hostname normalization strips brackets, case, and trailing dots', () => {
  assert.equal(normalizeHostname(new URL('http://[::1]/')), '::1');
  assert.equal(normalizeHostname('Example.COM.'), 'example.com');
});

test('local and blocked address policy', () => {
  for (const host of ['localhost', 'a.localhost', 'metadata.google.internal']) assert.equal(isLocalHostname(host), true, host);
  assert.equal(isLocalHostname('example.com'), false);
  for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '::1', 'fd00::1']) assert.equal(isBlockedAddress(ip), true, ip);
  assert.equal(isBlockedAddress('93.184.216.34'), false);
});

test('resolution rejects any private answer and reports unresolved hosts', async () => {
  const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
  assert.deepEqual(await resolvePublicAddresses('x.test', { lookupImpl: mixed }), { reason: 'private' });
  const fail = async () => { throw new Error('ENOTFOUND'); };
  assert.deepEqual(await resolvePublicAddresses('x.test', { lookupImpl: fail }), { reason: 'unresolved' });
  const ok = await resolvePublicAddresses('x.test', { lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }] });
  assert.equal(ok.addresses[0].address, '93.184.216.34');
});

test('pinnedRequest connects to the pinned address and enforces size limits', async (t) => {
  const server = createServer((req, res) => {
    res.setHeader('x-host', req.headers.host);
    res.end(req.url === '/big' ? 'x'.repeat(5000) : 'hello');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const addresses = [{ address: '127.0.0.1', family: 4 }];
  const small = await pinnedRequest(new URL(`http://pinned.example:${port}/`), { addresses, maxBytes: 1000 });
  assert.equal(small.status, 200);
  assert.equal(small.body.toString(), 'hello');
  assert.equal(small.headers.get('x-host'), `pinned.example:${port}`);
  const big = await pinnedRequest(new URL(`http://pinned.example:${port}/big`), { addresses, maxBytes: 1000 });
  assert.equal(big.tooLarge, true);
});

test('readBoundedBody returns null past the limit', async () => {
  assert.equal(await readBoundedBody(new Response('x'.repeat(50)), 10), null);
  assert.equal((await readBoundedBody(new Response('abc'), 10)).toString(), 'abc');
});
