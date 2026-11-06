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

test('the response-header timeout covers each attempt, not the whole retry sequence', async (t) => {
  const { createServer } = await import('node:http');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createSession, requestCompletion, closeSession } = await import('../src/agent.mjs');
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++;
    if (requests <= 3) {
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0.8' });
      res.end(JSON.stringify({ error: { message: 'overloaded' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'recovered' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-retry-timer-'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: 'k' }, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); server.close(); await rm(root, { recursive: true, force: true }); });
  session.messages.push({ role: 'user', content: 'hi' });
  // Three 0.8 s Retry-After waits (2.4 s) outlast a 1.5 s header timeout, but
  // every attempt answers immediately, so the request must not time out.
  const message = await requestCompletion(session, { timeoutMs: 1500, env: {} });
  assert.equal(message.content, 'recovered');
  assert.equal(requests, 4);
});

test('a Retry-After longer than the retry cap is not retried early', () => {
  assert.equal(providerRetryDelayMs(1, '30', () => 0), 30000, 'honoured up to a minute');
  assert.equal(providerRetryDelayMs(1, '600', () => 0), null, 'too long to wait inline: give up on retrying');
});

test('cancelling during a long Retry-After wait stops the request at once', async (t) => {
  const { createServer } = await import('node:http');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createSession, requestCompletion, closeSession } = await import('../src/agent.mjs');
  let requests = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    requests++;
    res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '45' });
    res.end(JSON.stringify({ error: { message: 'overloaded' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-retry-abort-'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: 'k' }, permissionMode: 'bypassPermissions' });
  t.after(async () => { closeSession(session); server.close(); await rm(root, { recursive: true, force: true }); });
  session.messages.push({ role: 'user', content: 'hi' });
  const controller = new AbortController();
  const waits = [];
  setTimeout(() => controller.abort(), 300);
  const started = Date.now();
  await assert.rejects(requestCompletion(session, { env: {}, signal: controller.signal, onProviderRetry: (event) => waits.push(event.waitMs) }), (error) => error.name === 'AbortError');
  assert.ok(Date.now() - started < 3000, 'took ' + (Date.now() - started) + ' ms');
  assert.deepEqual(waits, [45000], 'the advertised wait was honoured');
  assert.equal(requests, 1);
});
