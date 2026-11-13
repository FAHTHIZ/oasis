import test from 'node:test';
import assert from 'node:assert/strict';
import { runWithProviderBreaker, isOpen, retryInSeconds, isBreakerOpenError, providerBreakerKey, reset } from '../src/circuit-breaker.mjs';
import { fallbackReason, remainingFallbacks, parseFallbackChain } from '../src/fallback-chain.mjs';

const unavailable = () => { throw Object.assign(new Error('HTTP 503 overloaded'), { status: 503 }); };
const fail = async (key, options = {}) => { try { await runWithProviderBreaker(key, unavailable, options); } catch (error) { return error; } return null; };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the breaker opens after the threshold and then fails fast without calling the provider', async () => {
  reset();
  await fail('a', { threshold: 2, cooldownMs: 60000 });
  assert.equal(isOpen('a'), false);
  await fail('a');
  assert.equal(isOpen('a'), true);
  assert.ok(retryInSeconds('a') > 0);
  let called = false;
  const error = await runWithProviderBreaker('a', () => { called = true; }).catch((caught) => caught);
  assert.equal(called, false);
  assert.equal(isBreakerOpenError(error), true);
  assert.equal(fallbackReason(error), 'server', 'an open breaker moves the chain on');
});

test('failures the caller does not attribute to the provider never open it', async () => {
  reset();
  for (let i = 0; i < 5; i += 1) await fail('b', { threshold: 2, shouldTrip: () => false });
  assert.equal(isOpen('b'), false);
});

test('a success in between resets the count', async () => {
  reset();
  await fail('c', { threshold: 2 });
  assert.equal(await runWithProviderBreaker('c', () => 'ok'), 'ok');
  await fail('c');
  assert.equal(isOpen('c'), false);
});

test('after the cooldown one probe goes through; a failed probe doubles the cooldown, a good one closes', async () => {
  reset();
  await fail('d', { threshold: 1, cooldownMs: 40, maxCooldownMs: 1000 });
  assert.equal(isOpen('d'), true);
  await wait(55);
  assert.equal(isOpen('d'), false, 'cooldown over: ready for a probe');
  const probe = await fail('d');
  assert.equal(isBreakerOpenError(probe), false, 'the probe really called the provider');
  assert.equal(isOpen('d'), true);
  await wait(55);
  assert.equal(isOpen('d'), true, 'second cooldown is about 80 ms');
  await wait(45);
  assert.equal(await runWithProviderBreaker('d', () => 'back'), 'back');
  assert.equal(isOpen('d'), false);
});

test('breakers are per provider endpoint and model', () => {
  assert.equal(providerBreakerKey({ baseURL: 'https://API.example.com/v1/', model: 'm' }), 'https://api.example.com/v1#m');
  assert.equal(providerBreakerKey({ fallbackProvider: 'groq', baseURL: 'https://x', model: 'kimi' }), 'groq#kimi');
  assert.notEqual(providerBreakerKey({ baseURL: 'https://x', model: 'a' }), providerBreakerKey({ baseURL: 'https://x', model: 'b' }));
});

test('the fallback chain skips an entry whose breaker is open', async () => {
  reset();
  const base = { baseURL: 'https://x/v1', model: 'main', apiKey: 'k' };
  await fail(providerBreakerKey({ ...base, model: 'a' }), { threshold: 1, cooldownMs: 60000 });
  const chain = parseFallbackChain('a,b');
  assert.deepEqual(remainingFallbacks(chain, { current: base, baseConfig: base, env: {} }).map((item) => item.entry.id), ['b']);
});
