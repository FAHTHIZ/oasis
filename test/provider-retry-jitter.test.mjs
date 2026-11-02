import test from 'node:test';
import assert from 'node:assert/strict';
import { providerRetryDelayMs } from '../src/agent.mjs';

test('provider retry backoff is jittered but Retry-After is honoured exactly', () => {
  assert.equal(providerRetryDelayMs(1, null, () => 1), 250);
  assert.equal(providerRetryDelayMs(1, null, () => 0), 125);
  assert.equal(providerRetryDelayMs(3, null, () => 1), 1000);
  const spread = new Set(Array.from({ length: 20 }, (_, i) => providerRetryDelayMs(4, null, () => i / 19)));
  assert.ok(spread.size > 10, 'parallel callers get different delays');
  assert.equal(providerRetryDelayMs(2, '3', () => 0), 3000);
});
