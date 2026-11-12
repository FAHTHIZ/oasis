import test from 'node:test';
import assert from 'node:assert/strict';
import { runtimeToken, saveRuntimeToken, forgetRuntimeToken, deviceRemembered, detectRuntime, RuntimeClient } from '../app/core/runtime.mjs';

function storage() {
  const map = new Map();
  return { getItem: (k) => map.has(k) ? map.get(k) : null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k), map };
}
function win(hash = '') {
  return { location: { hash, pathname: '/app/', search: '', protocol: 'https:' }, history: { replaceState() {} }, sessionStorage: storage(), localStorage: storage() };
}
const KEY = 'k'.repeat(43);

test('the access key stays in the tab unless the person asks to remember this device', () => {
  const w = win();
  saveRuntimeToken(KEY, w);
  assert.equal(runtimeToken(w), KEY);
  assert.equal(deviceRemembered(w), false);
  assert.equal(w.localStorage.map.size, 0, 'nothing written to long-lived storage by default');
  saveRuntimeToken(KEY, w, { remember: true });
  assert.equal(deviceRemembered(w), true);
  w.sessionStorage.map.clear(); // a new tab
  assert.equal(runtimeToken(w), KEY, 'a remembered device reconnects without the link');
  forgetRuntimeToken(w);
  assert.equal(runtimeToken(w), '');
  assert.equal(deviceRemembered(w), false);
});

test('a fresh link replaces a remembered, rotated key; junk in storage is ignored', () => {
  const w = win('#token=' + 'n'.repeat(43));
  w.localStorage.setItem('oasis.web.token.device', KEY);
  assert.equal(runtimeToken(w), 'n'.repeat(43));
  assert.equal(w.localStorage.getItem('oasis.web.token.device'), 'n'.repeat(43));
  const junk = win();
  junk.localStorage.setItem('oasis.web.token.device', '<script>');
  assert.equal(runtimeToken(junk), '');
});

test('a stored key the server rejects is forgotten and reported as stale', async () => {
  const w = win();
  saveRuntimeToken(KEY, w, { remember: true });
  const fetchImpl = async () => ({ ok: false, status: 401, headers: { get: () => 'application/json' }, json: async () => ({ error: 'unauthorized' }), text: async () => '' });
  const found = await detectRuntime({ win: w, fetchImpl });
  assert.equal(found.needsToken, true);
  assert.equal(found.staleToken, true);
  assert.equal(deviceRemembered(w), false);
  assert.equal(runtimeToken(w), '');
});

test('a key that stops working mid-session tells the app once per request, then fails the request', async () => {
  let calls = 0;
  const client = new RuntimeClient({ token: KEY, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'This OASIS key is out of date.' }) }) });
  client.onUnauthorized = () => { calls += 1; };
  await assert.rejects(client.api('/api/status'), (error) => error.status === 401 && /out of date/.test(error.message));
  assert.equal(calls, 1);
  const ok = new RuntimeClient({ token: KEY, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ fine: true }) }) });
  ok.onUnauthorized = () => { calls += 1; };
  assert.deepEqual(await ok.api('/api/status'), { fine: true });
  assert.equal(calls, 1);
});
