// Regression: gateways answer some failures with HTTP 200 and an error body.
// Seen live from OpenRouter (2026-11-14) when a :free model was withdrawn.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { listRoutes } from '../src/quota-ledger.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const WITHDRAWN = 'meta-llama/llama-3.3-70b-instruct:free';
const LIVE_BODY = JSON.stringify({ error: { message: 'This model is unavailable for free. The paid version is available now - use this slug instead: meta-llama/llama-3.3-70b-instruct', code: 404 }, user_id: 'user_x' });
const json = (body) => new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
const done = () => json(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));

async function run({ fallbackModel = '', provider, extraEnv = {} }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-200err-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: dir, OASIS_TELEMETRY: '0', OASIS_NO_UPDATE_CHECK: '1', ...extraEnv };
  for (const name of ['OASIS_ZERO_BUDGET', 'OASIS_FREE_MODELS', 'OASIS_QUOTA_LEDGER']) if (!(name in extraEnv)) delete env[name];
  const sent = [];
  const fetchImpl = async (_url, init) => { const payload = JSON.parse(init.body); sent.push(payload.model); return provider(payload.model); };
  const config = { protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'k', model: WITHDRAWN, maxSteps: 3 };
  const session = await createSession({ root: dir, config, fallbackModel, settings, env });
  try {
    let result, error;
    try { result = await runAgentTurn(session, 'hi', { autoApprove: true, env, fetchImpl }); } catch (caught) { error = caught; }
    return { result, error, sent, routes: listRoutes(env) };
  } finally { await closeSession(session); await rm(dir, { recursive: true, force: true }); }
}

test('a 200 response with an error body falls back to the free backup, never to the suggested paid slug', async () => {
  const { result, sent } = await run({ fallbackModel: 'qwen/qwen3-coder:free', extraEnv: { OASIS_ZERO_BUDGET: '1' }, provider: (model) => model === WITHDRAWN ? json(LIVE_BODY) : done() });
  assert.equal(result.text, 'done');
  assert.deepEqual(sent, [WITHDRAWN, 'qwen/qwen3-coder:free']);
  assert.ok(!sent.includes('meta-llama/llama-3.3-70b-instruct'));
});

test('without a backup the provider\'s own error reaches the user with its status', async () => {
  const { error, sent } = await run({ provider: () => json(LIVE_BODY) });
  assert.ok(error, 'the turn fails');
  assert.equal(error.status, 404);
  assert.match(error.message, /unavailable for free/);
  assert.equal(sent.length, 1, 'not retried in a loop');
});

test('an in-body 429 is recorded in the quota ledger like an HTTP 429', async () => {
  const body = JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day', code: 429 } });
  const { error, routes } = await run({ provider: () => json(body) });
  assert.equal(error.status, 429);
  const route = routes.find((item) => item.model === WITHDRAWN);
  assert.ok(route && route.failures >= 1, JSON.stringify(routes));
});
