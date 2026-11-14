#!/usr/bin/env node
// Gateway behaviour benchmark: what reaches the providers, with no network.
//
// Each scenario runs the real runAgentTurn loop for several consecutive
// sessions against simulated providers (an injected fetch). Every HTTP
// request Oasis sends is counted with its model, outcome and the price the
// catalog gives that model, once with the feature under test off (baseline)
// and once on. Between sessions the in-memory circuit breaker is reset, as a
// new process would start, so only state Oasis persists carries over.
//
//   node bench/gateway/run.mjs              # table
//   node bench/gateway/run.mjs --json FILE  # full report
//   node bench/gateway/run.mjs --check      # exit 1 if a scenario's expectation fails
//
// These are simulations of provider behaviour (quota errors, prices), not
// live measurements; they show what Oasis sends, not how a real provider
// performs.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const argv = process.argv.slice(2);
const jsonOut = argv.includes('--json') ? argv[argv.indexOf('--json') + 1] : '';
const checkMode = argv.includes('--check');

const benchRoot = await mkdtemp(path.join(os.tmpdir(), 'oasis-gateway-bench-'));
process.env.OASIS_NO_UPDATE_CHECK = '1';
process.env.OASIS_TELEMETRY = '0';
for (const name of ['OASIS_ZERO_BUDGET', 'OASIS_MAX_REQUESTS', 'OASIS_MAX_TOTAL_TOKENS', 'OASIS_FREE_MODELS', 'OASIS_QUOTA_LEDGER']) delete process.env[name];
// Nothing here may reach the network.
globalThis.fetch = async (url) => { throw new Error('network access in benchmark: ' + url); };

const { createSession, runAgentTurn, closeSession } = await import('../../src/agent.mjs');
const { reset: resetBreakers } = await import('../../src/circuit-breaker.mjs');
const { estimateCostUsd } = await import('../../src/pricing.mjs');

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const USAGE = { prompt_tokens: 1200, completion_tokens: 150, total_tokens: 1350 };
const ok = (message, headers = {}) => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: USAGE }), { status: 200, headers: { 'content-type': 'application/json', ...headers } });
const fail = (status, message, headers = {}) => new Response(JSON.stringify({ error: { message } }), { status, headers: { 'content-type': 'application/json', ...headers } });
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

const scenarios = [
  {
    name: 'daily-quota-exhausted-primary',
    about: 'The main model\'s daily free quota is used up (429 with Retry-After 2 h); a backup model works. 5 sessions.',
    config: { model: 'coder-large' }, fallbackModel: 'coder-small', sessions: 5,
    provider: ({ model }) => model === 'coder-large' ? fail(429, 'Rate limit exceeded: free-models-per-day', { 'retry-after': '7200' }) : ok({ content: 'done' }),
    baseline: { OASIS_QUOTA_LEDGER: 'off' }, feature: {},
    expect: (base, feat) => feat.failedRequests === 1 && base.failedRequests === 5 && feat.succeeded === 5 && base.succeeded === 5
  },
  {
    name: 'zero-budget-paid-primary',
    about: 'The main model is paid (catalog $3/$15 per million tokens); a declared-free backup exists. 5 sessions.',
    config: { model: 'claude-sonnet-4-5' }, fallbackModel: 'free-coder', sessions: 5,
    provider: () => ok({ content: 'done' }),
    baseline: { OASIS_FREE_MODELS: 'free-coder' }, feature: { OASIS_FREE_MODELS: 'free-coder', OASIS_ZERO_BUDGET: '1' },
    expect: (base, feat) => feat.paidRequests === 0 && feat.estimatedCostUsd === 0 && base.paidRequests === 5 && feat.succeeded === 5
  },
  {
    name: 'zero-budget-no-free-route',
    about: 'Only a paid model is configured. Zero-budget mode must stop without sending anything. 3 sessions.',
    config: { model: 'claude-sonnet-4-5' }, fallbackModel: '', sessions: 3,
    provider: () => ok({ content: 'done' }),
    baseline: {}, feature: { OASIS_ZERO_BUDGET: '1' },
    expect: (base, feat) => feat.requests === 0 && feat.succeeded === 0 && base.paidRequests === 3
  },
  {
    name: 'runaway-tool-loop-request-budget',
    about: 'The model keeps calling tools and never finishes. --max-requests 8 against the default step limit. 1 session.',
    config: { model: 'free-coder', maxSteps: 40 }, fallbackModel: '', sessions: 1,
    provider: (_payload, n) => ok({ content: null, tool_calls: [call('c' + n, 'list_files', { path: n % 2 ? '.' : 'src', limit: n })] }),
    baseline: {}, feature: { OASIS_MAX_REQUESTS: '8' },
    expect: (base, feat) => feat.requests === 8 && base.requests > 8
  },
  {
    name: 'only-model-guessed-cooldown',
    about: 'The only model returns a quota 429 with no reset time, then recovers. A guess must never refuse your only model. 3 sessions.',
    config: { model: 'coder-large' }, fallbackModel: '', sessions: 3,
    provider: (_payload, n) => n === 1 ? fail(429, 'quota exceeded for this key') : ok({ content: 'done' }),
    baseline: { OASIS_QUOTA_LEDGER: 'off' }, feature: {},
    expect: (base, feat) => feat.succeeded === base.succeeded && feat.requests === base.requests
  }
];

async function runVariant(scenario, extraEnv) {
  const configDir = await mkdtemp(path.join(benchRoot, 'config-'));
  const root = await mkdtemp(path.join(benchRoot, 'work-'));
  const env = { ...process.env, ...extraEnv, OASIS_CONFIG_DIR: configDir };
  const config = { protocol: 'openai-compatible', baseURL: 'https://api.provider.test/v1', apiKey: 'bench-key', maxSteps: 6, ...scenario.config };
  const sent = [];
  let n = 0;
  const fetchImpl = async (url, init) => {
    const payload = JSON.parse(init.body);
    n++;
    const response = await scenario.provider(payload, n);
    sent.push({ model: payload.model, status: response.status });
    return response;
  };
  const outcomes = [];
  for (let i = 0; i < scenario.sessions; i++) {
    resetBreakers();
    const session = await createSession({ root, config, fallbackModel: scenario.fallbackModel, settings, env });
    try {
      const result = await runAgentTurn(session, 'do the task', { autoApprove: true, env, fetchImpl });
      outcomes.push({ ok: Boolean(result && result.finished), stop: result && result.finished ? '' : 'unfinished' });
    } catch (error) {
      outcomes.push({ ok: false, stop: error && error.code || 'error' });
    } finally { await closeSession(session); }
  }
  const usage = { inputTokens: USAGE.prompt_tokens, outputTokens: USAGE.completion_tokens };
  const priced = sent.filter((item) => item.status === 200).map((item) => estimateCostUsd(item.model, usage, { config: { ...config, model: item.model }, env: {} }));
  return {
    requests: sent.length,
    failedRequests: sent.filter((item) => item.status !== 200).length,
    paidRequests: sent.filter((item) => estimateCostUsd(item.model, usage, { config: { ...config, model: item.model }, env: {} }) > 0).length,
    estimatedCostUsd: Number(priced.reduce((sum, value) => sum + value, 0).toFixed(6)),
    tokensBilled: sent.filter((item) => item.status === 200).length * USAGE.total_tokens,
    succeeded: outcomes.filter((item) => item.ok).length,
    sessions: scenario.sessions,
    stops: [...new Set(outcomes.map((item) => item.stop).filter(Boolean))],
    models: sent.map((item) => item.model + ':' + item.status)
  };
}

const report = { generatedAt: new Date().toISOString(), node: process.version, note: 'Simulated providers; counts what Oasis sends. Not a live measurement.', scenarios: [] };
let failed = 0;
for (const scenario of scenarios) {
  const baseline = await runVariant(scenario, scenario.baseline);
  const feature = await runVariant(scenario, scenario.feature);
  const pass = Boolean(scenario.expect(baseline, feature));
  if (!pass) failed++;
  report.scenarios.push({ name: scenario.name, about: scenario.about, baseline, feature, pass });
}
await rm(benchRoot, { recursive: true, force: true });

const pad = (value, width) => String(value).padEnd(width);
console.log(pad('scenario', 34) + pad('variant', 10) + pad('requests', 10) + pad('failed', 8) + pad('paid', 6) + pad('est. $', 10) + pad('tokens', 9) + 'succeeded');
for (const item of report.scenarios) {
  for (const [label, row] of [['baseline', item.baseline], ['feature', item.feature]]) {
    console.log(pad(label === 'baseline' ? item.name : '', 34) + pad(label, 10) + pad(row.requests, 10) + pad(row.failedRequests, 8) + pad(row.paidRequests, 6) + pad(row.estimatedCostUsd.toFixed(4), 10) + pad(row.tokensBilled, 9) + row.succeeded + '/' + row.sessions + (row.stops.length ? '  (' + row.stops.join(', ') + ')' : ''));
  }
  console.log(pad('', 34) + (item.pass ? 'expectation met' : 'EXPECTATION FAILED'));
}
if (jsonOut) await writeFile(jsonOut, JSON.stringify(report, null, 2) + '\n');
if (checkMode && failed) { console.error(failed + ' scenario(s) failed their expectation.'); process.exit(1); }
