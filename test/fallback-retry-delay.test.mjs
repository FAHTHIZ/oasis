import test from 'node:test';
import assert from 'node:assert/strict';
import { retryDelayMs } from '../src/fallback-chain.mjs';

test('delay grows exponentially without jitter', () => {
  assert.equal(retryDelayMs(0, 1000, 30000, false), 1000);
  assert.equal(retryDelayMs(1, 1000, 30000, false), 2000);
  assert.equal(retryDelayMs(2, 1000, 30000, false), 4000);
  assert.equal(retryDelayMs(3, 1000, 30000, false), 8000);
});

test('delay is capped at maxMs', () => {
  assert.equal(retryDelayMs(10, 1000, 30000, false), 30000);
  assert.equal(retryDelayMs(20, 1000, 30000, false), 30000);
});

test('jitter stays within bounds', () => {
  for (let i = 0; i < 100; i++) {
    const delay = retryDelayMs(2, 1000, 30000, true);
    assert.ok(delay >= 3000 && delay <= 5000, 'delay ' + delay + ' out of bounds');
  }
});

test('negative attempt is treated as 0', () => {
  assert.equal(retryDelayMs(-1, 1000, 30000, false), 1000);
});
