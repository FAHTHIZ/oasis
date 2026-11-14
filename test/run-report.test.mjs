import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildRunReport, formatRunReport, newRunTracker, trackFallback, trackUsage } from '../src/run-report.mjs';
import { normalizeUsage } from '../src/usage-estimate.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

test('cost is provider-reported only when every request carried the provider charge', () => {
  assert.equal(normalizeUsage({ prompt_tokens: 5, completion_tokens: 1, cost: 0.0004 }).providerCostUsd, 0.0004);
  assert.equal(normalizeUsage({ prompt_tokens: 5, completion_tokens: 1 }).providerCostUsd, undefined);

  const all = newRunTracker();
  trackUsage(all, { inputTokens: 100, outputTokens: 10, costUsd: 0.001, costKnown: true, providerCostUsd: 0.0012, model: 'a' });
  trackUsage(all, { inputTokens: 50, outputTokens: 5, costUsd: 0.0005, costKnown: true, providerCostUsd: 0.0006, model: 'a', cacheReadTokens: 40 });
  const full = buildRunReport(all, { result: { finished: true, toolCalls: 2 } });
  assert.equal(full.cost.source, 'provider-reported');
  assert.ok(Math.abs(full.cost.usd - 0.0018) < 1e-12);
  assert.ok(Math.abs(full.cost.estimateUsd - 0.0015) < 1e-12);
  assert.deepEqual(full.models, [{ model: 'a', requests: 2, inputTokens: 150, outputTokens: 15 }]);
  assert.equal(full.tokens.cacheRead, 40);
  assert.equal(full.outcome, 'finished');

  const partial = newRunTracker();
  trackUsage(partial, { inputTokens: 100, outputTokens: 10, costUsd: 0.001, costKnown: true, providerCostUsd: 0.0012, model: 'a' });
  trackUsage(partial, { inputTokens: 100, outputTokens: 10, costKnown: false, model: 'b', estimated: true });
  trackUsage(partial, { inputTokens: 20, outputTokens: 5, phase: 'compaction', costUsd: 0 });
  trackFallback(partial, { from: 'a', to: 'b', kind: 'rate', reason: 'HTTP 429' });
  const report = buildRunReport(partial, { result: { finished: true, verificationIncomplete: true, verificationIssues: ['no check ran'] } });
  assert.equal(report.cost.usd, null);
  assert.match(report.cost.source, /^unknown/);
  assert.equal(report.cost.providerReportedRequests, 1);
  assert.equal(report.requests, 2);
  assert.equal(report.sideRequests, 1);
  assert.equal(report.tokens.source, '1 of 3 request(s) estimated from text length');
  assert.equal(report.outcome, 'finished, not verified');
  const text = formatRunReport(report);
  assert.match(text, /Not verified: no check ran/);
  assert.match(text, /Fallback: a -> b \(rate\): HTTP 429/);
  assert.match(text, /Cost: unknown/);
  assert.match(text, /External CLIs, MCP servers and hooks/);
  assert.equal(formatRunReport(null), 'No task has run in this session yet.');

  const leaky = newRunTracker();
  trackFallback(leaky, { from: 'a', to: 'b', kind: 'auth', reason: 'HTTP 401: Incorrect API key provided: sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD' });
  assert.doesNotMatch(formatRunReport(buildRunReport(leaky, {})), /abcdefghijklmnop/);
});

test('a real turn records its fallback, provider-reported cost and outcome, and /report shows them', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-run-report-'));
  const env = { ...process.env, OASIS_CONFIG_DIR: dir, OASIS_TELEMETRY: '0', OASIS_NO_UPDATE_CHECK: '1' };
  for (const name of ['OASIS_ZERO_BUDGET', 'OASIS_FREE_MODELS', 'OASIS_QUOTA_LEDGER']) delete env[name];
  const fetchImpl = async (_url, init) => {
    const { model } = JSON.parse(init.body);
    if (model === 'primary/model:free') return new Response(JSON.stringify({ error: { message: 'Rate limit exceeded: free-models-per-day', code: 429 } }), { status: 429, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done' } }], usage: { prompt_tokens: 120, completion_tokens: 8, cost: 0.00042 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
  const config = { protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'k', model: 'primary/model:free', maxSteps: 3 };
  const session = await createSession({ root: dir, config, fallbackModel: 'backup/model:free', settings, env });
  try {
    const result = await runAgentTurn(session, 'hi', { autoApprove: true, env, fetchImpl });
    assert.equal(result.text, 'done');
    const report = result.runReport;
    assert.equal(report.outcome, 'finished');
    assert.deepEqual(report.models.map((row) => row.model), ['backup/model:free']);
    assert.equal(report.fallbacks.length, 1);
    assert.equal(report.fallbacks[0].to, 'backup/model:free');
    assert.equal(report.cost.source, 'provider-reported');
    assert.equal(report.cost.usd, 0.00042);
    assert.equal(session.lastRunReport, report);
    const shown = await runBuiltinCommand('report', '', { root: dir, session, env, sessionOptions: {} });
    assert.match(shown.output, /^Last task: finished/);
    assert.match(shown.output, /Fallback: primary\/model:free -> backup\/model:free/);
    assert.match(shown.output, /Cost: \$0\.000420 \(provider-reported\)/);
    const raw = JSON.parse((await runBuiltinCommand('report', 'json', { root: dir, session, env, sessionOptions: {} })).output);
    assert.equal(raw.cost.usd, 0.00042);
  } finally { await closeSession(session); await rm(dir, { recursive: true, force: true }); }
});
