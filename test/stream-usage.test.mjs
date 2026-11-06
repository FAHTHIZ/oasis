import test from 'node:test';
import assert from 'node:assert/strict';
import { countTextTokens } from '../src/tokens.mjs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession, mergeAnthropicUsage, usageOrEstimate, consultAdvisor, chargeAuxiliaryUsage } from '../src/agent.mjs';
import { carryLearnedContextWindow } from '../src/config.mjs';
import { createUsageTracker, recordUsage, runBuiltinCommand } from '../src/slash.mjs';

const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';

// OpenAI-compatible streaming server. Usage is only sent when the request asks
// for it with stream_options.include_usage, like api.openai.com.
async function usageServer(t, { rejectStreamOptions = false, neverUsage = false } = {}) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    bodies.push(body);
    if (rejectStreamOptions && body.stream_options) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Unrecognized request argument supplied: stream_options' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(sse({ choices: [{ index: 0, delta: { content: 'Done.' } }] }));
    res.write(sse({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
    if (!neverUsage && body.stream_options && body.stream_options.include_usage) {
      res.write(sse({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 800 } } }));
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { bodies, baseURL: 'http://127.0.0.1:' + server.address().port + '/v1' };
}

async function makeSession(t, baseURL, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-usage-'));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL, model: 'fixture', apiKey: '', maxSteps: 3 }, permissionMode: 'bypassPermissions', ...extra });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  return session;
}

const env = { ...process.env, OASIS_PRICE_INPUT: '10', OASIS_PRICE_OUTPUT: '20', OASIS_PRICE_CACHE_READ: '1' };

test('OpenAI-compatible streams request usage and price it, including cached input', async (t) => {
  const server = await usageServer(t);
  const session = await makeSession(t, server.baseURL);
  const reports = [];
  await runAgentTurn(session, 'hi', { onDelta: () => {}, onUsage: (u) => reports.push(u), env });
  assert.deepEqual(server.bodies[0].stream_options, { include_usage: true });
  const step = reports.find((u) => u.phase === undefined);
  assert.equal(step.inputTokens, 1000);
  assert.equal(step.outputTokens, 100);
  assert.equal(step.cacheReadTokens, 800);
  // 200 uncached input * $10 + 800 cached * $1 + 100 output * $20, per million.
  assert.ok(Math.abs(step.costUsd - (200 * 10 + 800 * 1 + 100 * 20) / 1e6) < 1e-12);
  assert.ok(session.costUsd > 0);
});

test('a gateway that rejects stream_options is retried without it and remembered', async (t) => {
  const server = await usageServer(t, { rejectStreamOptions: true });
  const session = await makeSession(t, server.baseURL);
  const reports = [];
  const result = await runAgentTurn(session, 'hi', { onDelta: () => {}, onUsage: (u) => reports.push(u), env });
  assert.equal(result.text, 'Done.');
  assert.equal(server.bodies.length, 2);
  assert.ok(server.bodies[0].stream_options);
  assert.equal(server.bodies[1].stream_options, undefined);
  assert.equal(session.streamUsageUnsupported, true);
  // No usage came back, so tokens are estimated rather than silently zero.
  const step = reports.find((u) => u.phase === undefined);
  assert.equal(step.estimated, true);
  assert.ok(step.inputTokens > 0 && step.costUsd > 0);
});

test('--max-budget-usd still trips when a gateway never reports usage', async (t) => {
  const server = await usageServer(t, { neverUsage: true });
  const session = await makeSession(t, server.baseURL, { maxBudgetUsd: 0.000001 });
  await assert.rejects(runAgentTurn(session, 'hi', { onDelta: () => {}, env }), (error) => error.code === 'BUDGET_EXCEEDED');
});

test('Anthropic stream usage keeps cache reads/writes and cumulative message_delta counts', () => {
  const usage = { input_tokens: 0, output_tokens: 0 };
  mergeAnthropicUsage(usage, { input_tokens: 12, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000, output_tokens: 1 });
  mergeAnthropicUsage(usage, { output_tokens: 250 });
  assert.deepEqual(usage, { input_tokens: 12, output_tokens: 250, cache_creation_input_tokens: 3000, cache_read_input_tokens: 40000 });
  // A later delta that repeats full counts updates them; zeros never erase them.
  mergeAnthropicUsage(usage, { input_tokens: 0, cache_read_input_tokens: 40000, output_tokens: 260 });
  assert.equal(usage.input_tokens, 12);
  assert.equal(usage.output_tokens, 260);
});

test('usageOrEstimate keeps reported usage and estimates only when none was sent', () => {
  assert.deepEqual(usageOrEstimate({ prompt_tokens: 5, completion_tokens: 1 }, 'x'.repeat(400), { content: 'hi' }), { inputTokens: 5, outputTokens: 1, totalTokens: 6 });
  const estimated = usageOrEstimate({}, 'x'.repeat(400), { content: 'y'.repeat(40), tool_calls: [{ function: { name: 'read_file', arguments: '{"path":"a"}' } }] });
  assert.equal(estimated.estimated, true);
  assert.equal(estimated.inputTokens, countTextTokens('x'.repeat(400)));
  assert.equal(estimated.outputTokens, countTextTokens('y'.repeat(40)) + countTextTokens('{"path":"a"}') + countTextTokens('read_file'));
});

test('advisor calls count their normalized tokens and cost against the budget ledger', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Check the parser first.' } }], usage: { prompt_tokens: 2000, completion_tokens: 50 } }), { status: 200, headers: { 'content-type': 'application/json' } });
  const previous = { ...process.env };
  Object.assign(process.env, { OASIS_PRICE_INPUT: '10', OASIS_PRICE_OUTPUT: '20' });
  try {
    const session = { config: { protocol: 'openai-compatible', baseURL: 'https://gateway.example/v1', model: 'worker', apiKey: 'k' }, advisorModel: 'big-advisor', messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'fix it' }] };
    const seen = [];
    const answer = await consultAdvisor(session, { question: 'where?' }, { onUsage: (u) => seen.push(u) });
    assert.match(answer.advice, /parser/);
    assert.equal(session.advisorUsage.input, 2000);
    assert.equal(session.advisorUsage.output, 50);
    const expected = (2000 * 10 + 50 * 20) / 1e6;
    assert.ok(Math.abs(session.budgetLedger.spentUsd - expected) < 1e-12);
    assert.equal(seen[0].phase, 'advisor');
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of ['OASIS_PRICE_INPUT', 'OASIS_PRICE_OUTPUT']) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

test('side requests never throw on the budget; the next main step enforces it', () => {
  const session = { config: { model: 'x' }, maxBudgetUsd: 0.001 };
  const cost = chargeAuxiliaryUsage(session, { inputTokens: 1000, outputTokens: 0 }, { env: { OASIS_PRICE_INPUT: '10' } });
  assert.equal(cost, 0.01);
  assert.equal(session.budgetLedger.spentUsd, 0.01);
});

test('/cost reports prompt-cache use, side-request spend and estimated requests', async () => {
  const usage = createUsageTracker();
  recordUsage(usage, { inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cacheReadTokens: 900, costUsd: 0.01 });
  recordUsage(usage, { inputTokens: 0, outputTokens: 0, totalTokens: 300, phase: 'compaction', costUsd: 0.02 });
  recordUsage(usage, { inputTokens: 10, outputTokens: 1, totalTokens: 11, estimated: true, costUsd: 0 });
  assert.ok(Math.abs(usage.costUSD - 0.03) < 1e-12);
  const { output } = await runBuiltinCommand('cost', '', { usage, session: null, env: process.env });
  assert.match(output, /900 input tokens read from cache \(89% of input\)/);
  assert.match(output, /Includes \$0\.02 for compaction summaries and advisor calls/);
  assert.match(output, /1 request\(s\) had no provider usage report/);
});

test('a learned context window survives the per-turn config reload for the same model only', () => {
  const learned = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen', contextWindow: 8192 };
  const fresh = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen' };
  assert.equal(carryLearnedContextWindow(learned, fresh).contextWindow, 8192);
  assert.equal(carryLearnedContextWindow(learned, { ...fresh, model: 'llama' }).contextWindow, undefined);
  assert.equal(carryLearnedContextWindow(learned, { ...fresh, contextWindow: 32768 }).contextWindow, 32768);
  assert.equal(carryLearnedContextWindow(null, fresh), fresh);
});

test('OpenAI cache writes are tracked and billed at the 30-minute and 12-hour rates', async () => {
  const { usageOrEstimate } = await import('../src/agent.mjs');
  const { estimateCostUsd } = await import('../src/pricing.mjs');
  const usage = usageOrEstimate({ input_tokens: 12000, output_tokens: 0, input_tokens_details: { cached_tokens: 4000, cache_write_tokens: 7000, cache_write_tokens_details: { ttl_30m_tokens: 3000, ttl_12h_tokens: 4000 } } }, '');
  assert.equal(usage.cacheReadTokens, 4000);
  assert.equal(usage.cacheCreationTokens, 7000);
  assert.equal(usage.cacheWriteLongTokens, 4000);
  // gpt-5.6-sol: $4 input, $0.40 cached, $5 (1.25x) 30-minute writes, $10 (2.5x) 12-hour writes.
  const expected = (1000 * 4 + 4000 * 0.4 + 3000 * 5 + 4000 * 10) / 1e6;
  assert.ok(Math.abs(estimateCostUsd('gpt-5.6-sol', usage, { env: {} }) - expected) < 1e-12);
});
