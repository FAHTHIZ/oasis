// Regression: Pollinations' anonymous tier answered HTTP 200 with the budget
// notice as the assistant text (seen live, November 2026). OASIS took it as
// the model's answer and never tried the fallback model.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gatewayBudgetNotice } from '../src/api-error.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { listRoutes } from '../src/quota-ledger.mjs';

const LIVE_NOTICE = 'The API key used for this request has reached its budget. Please [raise the key budget](https://enter.pollinations.ai/edit-key?id=XXXX&ref=agent_key_budget), then try again.\n\nTopping up the wall';
const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };

test('only the exact gateway notice is recognised', () => {
  assert.match(gatewayBudgetNotice({ content: LIVE_NOTICE }, { id: 'pllns_1' }), /^The API key used for this request has reached its budget\. Please/);
  assert.ok(gatewayBudgetNotice({ content: 'The API key used for this request has reached its budget. Try later.' }, { id: 'pllns_f75d' }), 'the response id identifies the gateway');
  // A model explaining budgets, or quoting the notice inside other text, is a real answer.
  assert.equal(gatewayBudgetNotice({ content: 'The API key used for this request has reached its budget. Raise it in your provider dashboard.' }, { id: 'chatcmpl-1' }), '');
  assert.equal(gatewayBudgetNotice({ content: 'Pollinations said: "' + LIVE_NOTICE + '"' }, { id: 'pllns_1' }), '');
  assert.equal(gatewayBudgetNotice({ content: LIVE_NOTICE, tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, {}), '');
  assert.equal(gatewayBudgetNotice({ content: '' }, {}), '');
  assert.equal(gatewayBudgetNotice(null), '');
});

async function run({ stream }) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-budget-notice-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: dir, OASIS_TELEMETRY: '0', OASIS_NO_UPDATE_CHECK: '1' };
  for (const name of ['OASIS_ZERO_BUDGET', 'OASIS_FREE_MODELS', 'OASIS_QUOTA_LEDGER', 'OASIS_NO_STREAM']) delete env[name];
  const sent = [];
  const reply = (model, content, id) => {
    if (!stream) return new Response(JSON.stringify({ id, choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    const chunks = [{ id, choices: [{ index: 0, delta: { role: 'assistant', content } }] }, { id, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }];
    return new Response(chunks.map((chunk) => 'data: ' + JSON.stringify(chunk) + '\n\n').join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const fetchImpl = async (_url, init) => {
    const payload = JSON.parse(init.body);
    sent.push(payload.model);
    return payload.model === 'openai' ? reply(payload.model, LIVE_NOTICE, 'pllns_f75da736') : reply(payload.model, 'Real answer from the backup.', 'chatcmpl-2');
  };
  const config = { protocol: 'openai-compatible', baseURL: 'https://text.pollinations.ai/openai', apiKey: '', model: 'openai', maxSteps: 3 };
  const session = await createSession({ root: dir, config, fallbackModel: 'backup-model', settings, env });
  try {
    const shown = [];
    const result = await runAgentTurn(session, 'hi', { autoApprove: true, env, fetchImpl, ...(stream ? { onDelta: (text) => shown.push(text) } : {}) });
    return { result, sent, routes: listRoutes(env) };
  } finally { await closeSession(session); await rm(dir, { recursive: true, force: true }); }
}

for (const stream of [false, true]) {
  test('a budget notice sent as a ' + (stream ? 'streamed' : 'plain') + ' 200 reply moves to the fallback model and is counted as a quota failure', async () => {
    const { result, sent, routes } = await run({ stream });
    assert.equal(result.text, 'Real answer from the backup.');
    assert.deepEqual(sent, ['openai', 'backup-model']);
    const route = routes.find((item) => item.model === 'openai');
    assert.ok(route && route.quotaFailures === 1, JSON.stringify(routes));
  });
}
