import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRetryDelayMs, providerRetryLimit } from '../src/agent.mjs';

test('provider retry backoff is jittered but Retry-After is honoured exactly', () => {
  assert.equal(providerRetryDelayMs(1, null, () => 1), 250);
  assert.equal(providerRetryDelayMs(1, null, () => 0), 125);
  assert.equal(providerRetryDelayMs(2, null, () => 1), 500);
  const spread = new Set(Array.from({ length: 20 }, (_, i) => providerRetryDelayMs(4, null, () => i / 19)));
  assert.ok(spread.size > 10, 'parallel callers get different delays');
  assert.equal(providerRetryDelayMs(2, '3', () => 0), 3000);
});

test('server errors get patient retries after the quick ones', () => {
  assert.deepEqual([3, 4, 5, 6].map((n) => providerRetryDelayMs(n, null, () => 1)), [2000, 5000, 12000, 12000]);
  assert.equal(providerRetryLimit(500, {}), 5);
  assert.equal(providerRetryLimit(503, {}), 5);
  assert.equal(providerRetryLimit(0, {}), 5, 'dropped connections');
  assert.equal(providerRetryLimit(429, {}), 2, 'rate limits keep their own waits');
  assert.equal(providerRetryLimit(408, {}), 2);
  assert.equal(providerRetryLimit(500, { OASIS_PROVIDER_RETRIES: '1' }), 1);
  assert.equal(providerRetryLimit(500, { OASIS_PROVIDER_RETRIES: '0' }), 0);
  assert.equal(providerRetryLimit(500, { OASIS_PROVIDER_RETRIES: 'lots' }), 5);
});
