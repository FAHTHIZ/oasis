import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { routeCost, zeroBudgetEnabled, assertZeroBudgetRoute, chargeRequestAttempt, recordTokenUsage } from '../src/cost-policy.mjs';
import { fallbackReason } from '../src/fallback-chain.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const noEnv = {};

test('routeCost admits only routes with evidence that they cannot bill', () => {
  const cost = (config, extra = {}) => routeCost(config, { env: noEnv, ...extra }).cost;
  assert.equal(cost({ protocol: 'ollama', baseURL: 'http://127.0.0.1:11434', model: 'qwen3:8b' }), 'free');
  assert.equal(cost({ protocol: 'openai-compatible', baseURL: 'http://localhost:1234/v1', model: 'gemma-3' }), 'free');
  // A loopback service on another port may be LiteLLM or OmniRoute forwarding to a paid model.
  assert.equal(cost({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:4000/v1', model: 'llama3' }), 'unknown');
  assert.notEqual(cost({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:20128/v1', model: 'llm7/codestral-latest' }), 'free', 'OmniRoute routes to cloud models');
  assert.equal(cost({ protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: 'qwen/qwen3-coder:free', apiKey: 'k' }), 'free');
  assert.equal(cost({ protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: 'anthropic/claude-sonnet-4.5', apiKey: 'k' }), 'paid');
  assert.equal(cost({ protocol: 'openai-compatible', baseURL: 'https://api.example.com/v1', model: 'mystery-model', apiKey: 'k' }), 'unknown');
  // A ":free" suffix only means free on OpenRouter.
  assert.equal(cost({ protocol: 'openai-compatible', baseURL: 'https://api.example.com/v1', model: 'mystery:free', apiKey: 'k' }), 'unknown');
  assert.equal(cost({ protocol: 'openai-compatible', baseURL: 'https://api.example.com/v1', model: 'mystery-model', keyless: true }), 'free');
  assert.equal(routeCost({ baseURL: 'https://api.example.com/v1', model: 'gemini-2.5-flash', apiKey: 'k' }, { env: { OASIS_FREE_MODELS: 'gemini-*' } }).cost, 'free');
  assert.equal(routeCost({ baseURL: 'https://api.example.com/v1', model: 'm', apiKey: 'k' }, { env: { OASIS_PRICE_INPUT: '0', OASIS_PRICE_OUTPUT: '0' } }).cost, 'free');
});

test('zero-budget mode is off by default and the environment overrides settings', () => {
  assert.equal(zeroBudgetEnabled({}, noEnv), false);
  assert.equal(zeroBudgetEnabled({ zeroBudget: true }, noEnv), true);
  assert.equal(zeroBudgetEnabled({ zeroBudget: true }, { OASIS_ZERO_BUDGET: '0' }), false);
  assert.equal(zeroBudgetEnabled({}, { OASIS_ZERO_BUDGET: '1' }), true);
  const error = (() => { try { assertZeroBudgetRoute({ zeroBudget: true }, { baseURL: 'https://api.example.com/v1', model: 'x', apiKey: 'k' }, noEnv); } catch (e) { return e; } })();
  assert.equal(error.code, 'OASIS_ZERO_BUDGET_BLOCKED');
  assert.equal(fallbackReason(error), 'paid', 'the fallback chain moves on');
  assert.equal(assertZeroBudgetRoute({}, { baseURL: 'https://api.example.com/v1', model: 'x' }, noEnv), null);
});

test('request and token budgets count attempts and stop before passing a limit', () => {
  const session = { maxRequests: 2, maxTotalTokens: 1000 };
  chargeRequestAttempt(session, { estimatedInputTokens: 100, env: noEnv });
  recordTokenUsage(session, { inputTokens: 100, outputTokens: 50 });
  chargeRequestAttempt(session, { estimatedInputTokens: 100, env: noEnv });
  assert.throws(() => chargeRequestAttempt(session, { env: noEnv }), (e) => e.code === 'REQUEST_BUDGET_EXCEEDED' && /saved/.test(e.message));
  assert.equal(session.budgetLedger.requests, 2, 'a refused attempt is not counted');
  const tokens = { maxTotalTokens: 500 };
  recordTokenUsage(tokens, { totalTokens: 450 });
  assert.throws(() => chargeRequestAttempt(tokens, { estimatedInputTokens: 60, env: noEnv }), (e) => e.code === 'TOKEN_BUDGET_EXCEEDED');
  assert.equal(fallbackReason({ code: 'REQUEST_BUDGET_EXCEEDED', message: 'x' }), '', 'a budget stop is not a reason to try another model');
});

// The fixture listens on a random loopback port, which routeCost treats as unknown.
async function modelServer(t, reply) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    seen.push(payload.model);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...reply(payload, seen.length) } }], usage: { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { seen, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 8 } };
}

async function tempRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cost-policy-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('zero-budget mode sends nothing to a route of unknown cost', async (t) => {
  const root = await tempRoot(t);
  const { seen, config } = await modelServer(t, () => ({ content: 'hello' }));
  const session = await createSession({ root, config, settings: { ...settings, zeroBudget: true } });
  t.after(() => closeSession(session));
  await assert.rejects(runAgentTurn(session, 'hi', { autoApprove: true, env: noEnv }), /Zero-budget mode refused fixture before sending anything/);
  assert.deepEqual(seen, [], 'the provider never received a request');
});

test('zero-budget mode skips a fallback entry that is not free and uses one that is', async (t) => {
  const root = await tempRoot(t);
  const { seen, config } = await modelServer(t, () => ({ content: 'answered for free' }));
  const session = await createSession({ root, config, fallbackModel: 'fixture-paid,fixture-free', settings: { ...settings, zeroBudget: true, freeModels: ['fixture-free'] } });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'hi', { autoApprove: true, env: noEnv });
  assert.equal(result.text, 'answered for free');
  assert.deepEqual(seen, ['fixture-free'], 'only the declared-free model was called');
});

test('--max-requests stops a looping run before the next request and keeps the conversation', async (t) => {
  const root = await tempRoot(t);
  const { seen, config } = await modelServer(t, (payload, n) => ({ content: null, tool_calls: [call('c' + n, 'list_files', { path: n % 2 ? '.' : 'sub', limit: n })] }));
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  await assert.rejects(runAgentTurn(session, 'look around', { autoApprove: true, env: { OASIS_MAX_REQUESTS: '3' } }), (e) => e.code === 'REQUEST_BUDGET_EXCEEDED');
  assert.equal(seen.length, 3, 'exactly the allowed number of requests reached the provider');
  assert.ok(session.messages.filter((m) => m.role === 'tool').length >= 3, 'work done before the stop is kept');
  assert.equal(session.budgetLedger.requests, 3);
  assert.equal(session.budgetLedger.tokens, 330);
});

test('side requests count against the parent budget', async (t) => {
  const root = await tempRoot(t);
  const { seen, config } = await modelServer(t, () => ({ content: 'ok' }));
  const session = await createSession({ root, config, settings: { ...settings, maxRequests: 1 } });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'hi', { autoApprove: true, env: noEnv });
  const { askSideQuestion } = await import('../src/agent.mjs');
  await assert.rejects(askSideQuestion(session, 'what happened?', { env: noEnv }), (e) => e.code === 'REQUEST_BUDGET_EXCEEDED');
  assert.equal(seen.length, 1);
});
