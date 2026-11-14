import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession, providerRetryDelayMs } from '../src/agent.mjs';
import { advertisedRetryAfterMs, serverRetryAdvice } from '../src/provider-retry.mjs';

const OK = JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'All set.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } });

test('retry-after-ms is read before Retry-After, and x-should-retry is parsed', () => {
  assert.equal(advertisedRetryAfterMs(new Headers({ 'retry-after-ms': '1500', 'retry-after': '9' })), 1500);
  assert.equal(advertisedRetryAfterMs(new Headers({ 'retry-after': '2' })), 2000);
  assert.equal(advertisedRetryAfterMs(new Headers()), null);
  assert.equal(providerRetryDelayMs(1, new Headers({ 'retry-after-ms': '40' })), 40);
  assert.equal(serverRetryAdvice(new Headers({ 'x-should-retry': 'true' })), true);
  assert.equal(serverRetryAdvice(new Headers({ 'x-should-retry': 'FALSE' })), false);
  assert.equal(serverRetryAdvice(new Headers()), null);
});

async function run(t, first) {
  let calls = 0;
  const server = createServer(async (req, res) => {
    for await (const _ of req) { /* drain */ }
    calls++;
    if (calls === 1) { res.writeHead(first.status, { 'content-type': 'application/json', ...first.headers }); res.end('{"error":{"message":"' + first.message + '"}}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(OK);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-retry-hdr-'));
  const configDir = await mkdtemp(path.join(os.tmpdir(), 'oasis-retry-hdr-cfg-'));
  t.after(async () => { server.close(); await rm(root, { recursive: true, force: true }); await rm(configDir, { recursive: true, force: true }); });
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SANDBOX: '0' };
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: 'x', approvalMode: 'auto' } });
  try {
    const result = await runAgentTurn(session, 'say hi', { env }).catch((error) => ({ error }));
    return { calls, result };
  } finally { await closeSession(session); }
}

test('x-should-retry: true retries a status that is not normally retried', async (t) => {
  const { calls, result } = await run(t, { status: 409, headers: { 'x-should-retry': 'true', 'retry-after-ms': '10' }, message: 'lock timeout' });
  assert.equal(calls, 2);
  assert.match(String(result.text), /All set/);
});

test('x-should-retry: false stops retries of a 503', async (t) => {
  const { calls } = await run(t, { status: 503, headers: { 'x-should-retry': 'false' }, message: 'gone for good' });
  assert.equal(calls, 1);
});
