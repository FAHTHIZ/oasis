import test from 'node:test';
import assert from 'node:assert/strict';
import { applySystemProxy, proxyFromPacResult, useSystemCertificates } from '../desktop/system-network.mjs';

test('PAC results map to a proxy URL; DIRECT and SOCKS do not', () => {
  assert.equal(proxyFromPacResult('PROXY proxy.corp:8080; DIRECT'), 'http://proxy.corp:8080');
  assert.equal(proxyFromPacResult('HTTPS secure.corp:443'), 'https://secure.corp:443');
  assert.equal(proxyFromPacResult('SOCKS5 s:1080; PROXY p:3128'), 'http://p:3128');
  assert.equal(proxyFromPacResult('DIRECT'), null);
  assert.equal(proxyFromPacResult('SOCKS5 s:1080'), null);
  assert.equal(proxyFromPacResult('PROXY bad host'), null);
});

test('the system proxy fills both envs, but never overrides what the user set', async () => {
  const session = { resolveProxy: async () => 'PROXY proxy.corp:8080' };
  const a = {}; const b = {};
  assert.equal(await applySystemProxy({ session, envs: [a, b] }), 'http://proxy.corp:8080');
  assert.equal(a.HTTPS_PROXY, 'http://proxy.corp:8080');
  assert.equal(b.HTTP_PROXY, 'http://proxy.corp:8080');
  const own = { https_proxy: 'http://mine:1' };
  assert.equal(await applySystemProxy({ session, envs: [own] }), null);
  assert.equal(own.HTTPS_PROXY, undefined);
  assert.equal(await applySystemProxy({ session, envs: [{ OASIS_PROXY: '0' }] }), null);
  assert.equal(await applySystemProxy({ session: { resolveProxy: async () => 'DIRECT' }, envs: [{}] }), null);
  assert.equal(await applySystemProxy({ session: { resolveProxy: async () => { throw new Error('x'); } }, envs: [{}] }), null);
});

test('OS certificates are added to the default set, once', () => {
  let set = null;
  const fakeTls = { getCACertificates: (kind) => kind === 'system' ? ['A', 'CORP'] : ['A', 'B'], setDefaultCACertificates: (list) => { set = list; } };
  assert.equal(useSystemCertificates(fakeTls, {}), 1);
  assert.deepEqual(set, ['A', 'B', 'CORP']);
  set = null;
  assert.equal(useSystemCertificates(fakeTls, { OASIS_SYSTEM_CA: '0' }), 0);
  assert.equal(set, null);
  assert.equal(useSystemCertificates({}, {}), 0, 'older Node: no-op');
});
