import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { reset as resetBreakers } from '../src/circuit-breaker.mjs';
import { quotaRoute, recordSuccess, recordFailure, recordTokens, assertRouteAvailable, readRoute, reportedLimits, isQuotaSignal, listRoutes, resetLedger, formatQuotaReport, ledgerPath } from '../src/quota-ledger.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const cloud = { protocol: 'openai-compatible', baseURL: 'https://api.example.test/v1', model: 'coder-large' };
const H = (entries) => new Headers(entries);

async function configDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-quota-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { OASIS_CONFIG_DIR: dir };
}

test('provider-reported limits are recorded as a timestamped snapshot', () => {
  const now = Date.parse('2026-11-14T10:00:00Z');
  const openai = reportedLimits(H({ 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '998', 'x-ratelimit-reset-requests': '6m0s', 'x-ratelimit-limit-tokens': '6000', 'x-ratelimit-remaining-tokens': '5100' }), now);
  assert.deepEqual(openai.requests, { limit: 1000, remaining: 998, resetAt: now + 360000 });
  assert.equal(openai.tokens.remaining, 5100);
  assert.equal(openai.at, now);
  const openrouter = reportedLimits(H({ 'x-ratelimit-limit': '50', 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1794787200000' }), now);
  assert.deepEqual(openrouter.requests, { limit: 50, remaining: 0, resetAt: 1794787200000 });
  assert.equal(reportedLimits(H({}), now), null, 'no headers means unknown, not zero');
});

test('only quota failures count as quota signals, not per-minute waits or outages', () => {
  assert.equal(isQuotaSignal(429, '{"error":{"message":"Rate limit exceeded: free-models-per-day"}}'), true);
  assert.equal(isQuotaSignal(402, '{"error":{"message":"Insufficient credits"}}'), true);
  assert.equal(isQuotaSignal(429, '1 reply every 45 seconds per IP. Retry after 5s'), false);
  assert.equal(isQuotaSignal(503, 'overloaded'), false);
});

test('a provider-stated reset blocks the route before sending, and a success clears it', async (t) => {
  const env = await configDir(t);
  const route = quotaRoute(cloud, 'sk-secret-123');
  const now = Date.now();
  recordFailure(route, { status: 429, headers: H({ 'retry-after': '3600' }), body: 'quota exceeded', env, now });
  assert.equal(readRoute(route, env).cooldown.source, 'provider');
  assert.throws(() => assertRouteAvailable(route, { env, hasFallback: false, now: now + 1000 }), (e) => e.code === 'OASIS_QUOTA_COOLDOWN' && /without sending a request/.test(e.message));
  assert.doesNotThrow(() => assertRouteAvailable(route, { env, now: now + 3601000 }), 'it expires on its own');
  recordSuccess(route, { headers: H({}), env, now: now + 2000 });
  assert.equal(readRoute(route, env).cooldown, undefined);
  const text = fs.readFileSync(ledgerPath(env), 'utf8');
  assert.ok(!text.includes('sk-secret-123'), 'the key itself is never stored');
  if (process.platform !== 'win32') assert.equal(fs.statSync(ledgerPath(env)).mode & 0o777, 0o600);
});

test('a guessed cooldown escalates, and only skips the route when a fallback exists', async (t) => {
  const env = await configDir(t);
  const route = quotaRoute(cloud, 'k');
  const now = Date.now();
  recordFailure(route, { status: 429, body: 'quota exceeded', env, now });
  assert.equal(readRoute(route, env).cooldown.until - now, 2 * 60000);
  recordFailure(route, { status: 429, body: 'quota exceeded', env, now: now + 1 });
  assert.equal(readRoute(route, env).cooldown.until - now - 1, 10 * 60000);
  assert.doesNotThrow(() => assertRouteAvailable(route, { env, hasFallback: false, now: now + 5 }), 'your only model is never refused on a guess');
  assert.throws(() => assertRouteAvailable(route, { env, hasFallback: true, now: now + 5 }), (e) => e.cooldownSource === 'guess');
});

test('OpenRouter daily-limit reset is read from the error body; local servers never cool down', async (t) => {
  const env = await configDir(t);
  const route = quotaRoute({ ...cloud, baseURL: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder:free' }, 'k');
  const now = Date.parse('2026-11-14T10:00:00Z');
  const body = '{"error":{"message":"Rate limit exceeded: free-models-per-day. ","code":429,"metadata":{"headers":{"X-RateLimit-Limit":"50","X-RateLimit-Remaining":"0","X-RateLimit-Reset":"1794787200000"}}}}';
  recordFailure(route, { status: 429, body, env, now });
  assert.deepEqual(readRoute(route, env).cooldown, { until: 1794787200000, source: 'provider', status: 429 });
  const local = quotaRoute({ protocol: 'ollama', baseURL: 'http://127.0.0.1:11434', model: 'qwen3' }, '');
  recordFailure(local, { status: 429, headers: H({ 'retry-after': '600' }), body: 'busy', env, now });
  assert.equal(readRoute(local, env).cooldown, undefined);
  assert.equal(readRoute(local, env).quotaFailures, 1, 'still counted');
});

test('daily counts roll over at the UTC day boundary; reset and report work', async (t) => {
  const env = await configDir(t);
  const route = quotaRoute(cloud, 'k');
  const day1 = Date.parse('2026-11-14T23:59:00Z');
  recordSuccess(route, { headers: H({ 'x-ratelimit-limit-requests': '100', 'x-ratelimit-remaining-requests': '99' }), env, now: day1 });
  recordTokens(route, { inputTokens: 1200, outputTokens: 80 }, { env, now: day1 });
  assert.equal(readRoute(route, env).requests, 1);
  recordSuccess(route, { env, now: day1 + 120000 });
  const record = readRoute(route, env);
  assert.equal(record.day, '2026-11-15');
  assert.equal(record.requests, 1);
  assert.equal(record.inputTokens, 0);
  assert.equal(record.reported.requests.remaining, 99, 'the last report is kept until replaced');
  const report = formatQuotaReport(listRoutes(env), day1 + 130000);
  assert.match(report, /coder-large {2}on api\.example\.test {2}key [0-9a-f]{10}/);
  assert.match(report, /99 of 100 left/);
  assert.match(report, /not a guarantee/);
  assert.equal(resetLedger(env, 'nothing-matches'), 0);
  assert.equal(resetLedger(env), 1);
  assert.deepEqual(listRoutes(env), []);
});

test('across sessions, a route the provider reported exhausted is skipped without a request', async (t) => {
  const env = await configDir(t);
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-quota-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const sent = [];
  const fetchImpl = async (url, init) => {
    const model = JSON.parse(init.body).model;
    sent.push(model);
    if (model === 'coder-large') return new Response('{"error":{"message":"Rate limit exceeded: free-models-per-day"}}', { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '7200' } });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'from backup' } }], usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 } }), { status: 200, headers: { 'content-type': 'application/json', 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '999' } });
  };
  const config = { ...cloud, apiKey: 'sk-test', maxSteps: 4 };
  const run = async () => {
    resetBreakers();
    const session = await createSession({ root, config, fallbackModel: 'coder-small', settings, env });
    try { return await runAgentTurn(session, 'hi', { autoApprove: true, env, fetchImpl }); } finally { await closeSession(session); }
  };
  const first = await run();
  assert.equal(first.text, 'from backup');
  assert.deepEqual(sent, ['coder-large', 'coder-small']);
  sent.length = 0;
  const second = await run();
  assert.equal(second.text, 'from backup');
  assert.deepEqual(sent, ['coder-small'], 'the exhausted model was not contacted again');
  const backup = listRoutes(env).find((r) => r.model === 'coder-small');
  assert.equal(backup.requests, 2);
  assert.equal(backup.inputTokens, 100);
  assert.equal(backup.reported.requests.remaining, 999);
});
