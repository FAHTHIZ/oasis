import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePaste } from '../app/core/connect.mjs';
import { localServerKey } from '../src/provider-connect.mjs';

const KEY = 'oasis_live_' + 'Ab3_'.repeat(8);

test('an OASIS Key pasted with the Route address is read as a key, not a model name', () => {
  const parsed = parsePaste('http://127.0.0.1:8081/v1 ' + KEY);
  assert.deepEqual(parsed.keys.map((k) => k.providers), [['oasis-route']]);
  assert.deepEqual(parsed.models, []);
});

test('oasis connect on the bare Route address uses OASIS_ROUTE_API_KEY, and only there', () => {
  const env = { OASIS_ROUTE_API_KEY: KEY };
  assert.equal(localServerKey(parsePaste('http://127.0.0.1:8081/v1'), env).key, KEY);
  assert.equal(localServerKey(parsePaste('http://localhost:8081'), env).name, 'OASIS Route');
  assert.equal(localServerKey(parsePaste('http://127.0.0.1:11434'), env).key, '', 'another local server');
  assert.equal(localServerKey(parsePaste('https://route.example.com:8081/v1'), env).key, '', 'not loopback');
  assert.equal(localServerKey(parsePaste('http://127.0.0.1:8081/v1 ' + 'oasis_live_' + 'Zz9-'.repeat(8)), env).key, '', 'a pasted key wins');
  assert.equal(localServerKey(parsePaste('http://127.0.0.1:8081/v1'), {}).key, '');
});
