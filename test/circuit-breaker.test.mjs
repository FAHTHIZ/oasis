import test from 'node:test';
import assert from 'node:assert/strict';
import { recordFailure, recordSuccess, isOpen, reset } from '../src/circuit-breaker.mjs';

test('breaker opens after threshold failures', () => {
  reset();
  const threshold = 3;
  assert.equal(isOpen('providerA', { cooldownMs: 60000 }), false);
  recordFailure('providerA', { threshold });
  recordFailure('providerA', { threshold });
  assert.equal(isOpen('providerA', { cooldownMs: 60000 }), false);
  recordFailure('providerA', { threshold });
  assert.equal(isOpen('providerA', { cooldownMs: 60000 }), true);
});

test('success resets the breaker', () => {
  reset();
  const threshold = 2;
  recordFailure('providerB', { threshold });
  recordFailure('providerB', { threshold });
  assert.equal(isOpen('providerB', { cooldownMs: 60000 }), true);
  recordSuccess('providerB');
  assert.equal(isOpen('providerB', { cooldownMs: 60000 }), false);
});

test('cooldown expiry allows a probe', () => {
  reset();
  const threshold = 1;
  recordFailure('providerC', { threshold });
  assert.equal(isOpen('providerC', { cooldownMs: 0 }), false);
});

test('unknown provider is never open', () => {
  reset();
  assert.equal(isOpen('never-seen', { cooldownMs: 60000 }), false);
});
