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
  assert.deepEqual([3, 4, 5, 6, 7, 8, 9].map((n) => providerRetryDelayMs(n, null, () => 1)), [2000, 5000, 10000, 20000, 30000, 30000, 30000]);
  assert.equal(providerRetryLimit(500, {}), 8);
  assert.equal(providerRetryLimit(503, {}), 8);
  assert.equal(providerRetryLimit(0, {}), 8, 'dropped connections');
  assert.equal(providerRetryLimit(429, {}), 2, 'rate limits keep their own waits');
  assert.equal(providerRetryLimit(408, {}), 2);
  assert.equal(providerRetryLimit(500, { OASIS_PROVIDER_RETRIES: '1' }), 1);
  assert.equal(providerRetryLimit(500, { OASIS_PROVIDER_RETRIES: '0' }), 0);
  assert.equal(providerRetryLimit(500, { OASIS_PROVIDER_RETRIES: 'lots' }), 8);
  assert.equal(providerRetryLimit(500, { OASIS_PROVIDER_RETRIES: '12' }), 12, 'can be raised');
  assert.equal(providerRetryLimit(500, { OASIS_PROVIDER_RETRIES: '99' }), 20);
});

test('a refused connection fails fast instead of waiting out the patient retries', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-refused-'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'm', apiKey: '' }, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  const started = Date.now();
  await assert.rejects(runAgentTurn(session, 'hi', {}));
  assert.ok(Date.now() - started < 10000, 'took ' + (Date.now() - started) + ' ms');
});
