// Gemini's OpenAI-compatible endpoint, as seen live on 2026-11-05:
// - a stray key under tools[].function fails the whole request (400);
// - Gemini 3 returns extra_content.google.thought_signature on tool calls and
//   rejects the next turn unless it is sent back;
// - errors arrive wrapped in an array: [{ error: {...} }].
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOL_DEFINITIONS } from '../src/tools.mjs';
import { chatCompletionTool, withProviderExtraContent, isGoogleGenerativeBaseURL, shortProviderReason, summarizeFallbackFailure } from '../src/agent.mjs';

const ALLOWED = new Set(['name', 'description', 'parameters', 'strict']);

test('every built-in tool keeps required inside parameters', () => {
  for (const tool of TOOL_DEFINITIONS) {
    const extra = Object.keys(tool.function).filter((key) => !ALLOWED.has(key));
    assert.deepEqual(extra, [], tool.function.name + ' has keys a strict server rejects');
    assert.equal(tool.function.parameters && tool.function.parameters.type, 'object', tool.function.name);
  }
});

test('chatCompletionTool drops keys outside the chat-completions tool shape', () => {
  const cleaned = chatCompletionTool({ type: 'function', function: { name: 'x', description: 'd', parameters: { type: 'object', properties: {} }, required: [], annotations: { readOnly: true } } });
  assert.deepEqual(cleaned, { type: 'function', function: { name: 'x', description: 'd', parameters: { type: 'object', properties: {} } } });
});

test('thought signatures go back to Gemini and nowhere else', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'list_files', arguments: '{}' }, extra_content: { google: { thought_signature: 'sig' } } }] },
    { role: 'tool', tool_call_id: 'a', content: '[]' }
  ];
  assert.equal(withProviderExtraContent(messages, 'https://generativelanguage.googleapis.com/v1beta/openai', 'gemini-3-flash'), messages);
  assert.equal(withProviderExtraContent(messages, 'http://127.0.0.1:4000/v1', 'gemini-3-flash'), messages, 'Gemini behind a gateway');
  const toOpenAI = withProviderExtraContent(messages, 'https://api.openai.com/v1', 'gpt-5');
  assert.equal(toOpenAI[1].tool_calls[0].extra_content, undefined);
  assert.equal(toOpenAI[1].tool_calls[0].function.name, 'list_files');
  assert.equal(messages[1].tool_calls[0].extra_content.google.thought_signature, 'sig', 'the session copy is untouched');
  assert.equal(isGoogleGenerativeBaseURL('https://generativelanguage.googleapis.com.evil.test/v1'), false);
});

test('fallback failures name every model and why', () => {
  const quota = Object.assign(new Error('Model provider returned HTTP 429: You exceeded your current quota. Generate content requests per day limit exceeded on Free Tier. Please retry in 21h11m1.6s.. Check the configured OpenAI-compatible chat completions endpoint, model name, credentials, and tool-calling support.'), { status: 429 });
  const gone = Object.assign(new Error('Model provider returned HTTP 404: This model models/gemini-2.5-flash is no longer available to new users.'), { status: 404 });
  assert.equal(shortProviderReason(quota), 'daily free-tier quota used up (retry in 21h11m)');
  assert.equal(shortProviderReason(gone), 'model retired by the provider');
  const error = summarizeFallbackFailure(gone, [{ model: 'gemini-3.6-flash', reason: shortProviderReason(quota) }, { model: 'gemini-2.5-flash', reason: shortProviderReason(gone) }]);
  assert.match(error.message, /All 2 models in the fallback chain failed/);
  assert.match(error.message, /gemini-3\.6-flash: daily free-tier quota used up \(retry in 21h11m\)/);
  assert.match(error.message, /no longer available/, 'the original message is kept for callers that read it');
  assert.equal(error.status, 404);
  const single = new Error('x');
  assert.equal(summarizeFallbackFailure(single, []).message, 'x');
});

test('the browser app keeps Gemini thought signatures across turns', async () => {
  const { chat } = await import('../app/core/providers.mjs');
  const { Agent } = await import('../app/core/agent.mjs');
  const bodies = [];
  const sse = (events) => new Response(events.map((e) => 'data: ' + JSON.stringify(e) + '\n\n').join('') + 'data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    bodies.push(body);
    if (bodies.length === 1) {
      return sse([{ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{}' }, extra_content: { google: { thought_signature: 'SIG' } } }] } }] }]);
    }
    const call = body.messages.find((m) => m.tool_calls).tool_calls[0];
    if (!call.extra_content) return new Response('[{"error":{"code":400,"message":"Function call is missing a thought_signature"}}]', { status: 400 });
    return sse([{ choices: [{ delta: { content: 'done' } }] }]);
  };
  const config = { protocol: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'k', model: 'gemini-3-flash', mode: 'auto' };
  const { Workspace, MemoryStore } = await import('../app/core/workspace.mjs');
  const workspace = await Workspace.create(new MemoryStore(), { name: 'p', files: [{ path: 'a.js', content: 'x' }] });
  const agent = new Agent({ getConfig: () => config, getContext: () => ({ workspace, skills: { promptSection: async () => '' } }), approve: async () => true, chatImpl: (c, o) => chat(c, { ...o, fetchImpl }) });
  assert.equal(await agent.send('hi'), 'done');
  for (const body of bodies) for (const tool of body.tools || []) assert.deepEqual(Object.keys(tool.function).filter((k) => !ALLOWED.has(k)), []);
  const err = await chat({ ...config, maxRetries: 0 }, { messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => new Response('[{"error":{"code":400,"message":"Unknown name required"}}]', { status: 400 }) }).catch((e) => e);
  assert.match(err.message, /Unknown name required/, 'array-wrapped errors are readable');
});

function geminiQuota429(quotaId, description, retry, retryDelay) {
  return JSON.stringify([{ error: { code: 429, message: 'You exceeded your current quota, please check your plan and billing details. * Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 5, model: gemini-3-flash, description: ' + description + '\nPlease retry in ' + retry + '.', status: 'RESOURCE_EXHAUSTED', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay }] } }], null, 2);
}

test('a Gemini per-minute limit is a short wait, not a billing error', async () => {
  const { shortRateLimitMs, isHardQuotaError, stopFailureType, formatWait } = await import('../src/agent.mjs');
  const minute = geminiQuota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'Generate content requests per minute limit exceeded on Free Tier.', '34.2s', '34s');
  const daily = geminiQuota429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'Generate content requests per day limit exceeded on Free Tier.', '21h11m1.6s', '76261s');
  assert.equal(shortRateLimitMs(minute), 34500);
  assert.equal(isHardQuotaError(minute), false);
  assert.equal(shortRateLimitMs(daily), null);
  assert.equal(isHardQuotaError(daily), true);
  assert.equal(stopFailureType(Object.assign(new Error(minute), { status: 429 })) === 'billing_error', false);
  assert.equal(shortRateLimitMs('insufficient_quota'), null);
  assert.equal(formatWait(34500), '35s');
  assert.equal(formatWait(150000), '3 min');
});

async function runAgainstRateLimitedGemini({ fails, fallback = '', serverErrors = 0 }) {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const models = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      models.push(body.model);
      if (models.length <= fails) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(geminiQuota429('GenerateContentInputTokensPerModelPerMinute-FreeTier', 'Generate content input tokens per minute limit exceeded on Free Tier.', '0.4s', '0s'));
        return;
      }
      if (models.length <= fails + serverErrors) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify([{ error: { code: 500, message: 'Internal error encountered.', status: 'INTERNAL' } }]));
        return;
      }
      const reply = { role: 'assistant', content: 'Recovered.' };
      if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: reply, finish_reason: 'stop' }] })); return; }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: 'Recovered.' } }] }) + '\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oasis-rpm-'));
  try {
    const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_MODEL: 'gemini-3-flash', OASIS_API_KEY: '', OASIS_SANDBOX: '0' };
    const args = [new URL('../src/cli.mjs', import.meta.url).pathname, '-p', 'hi'];
    if (fallback) args.push('--fallback-model', fallback);
    const child = spawn(process.execPath, args, { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    return { code, out, err, models };
  } finally {
    server.close();
    await fs.rm(home, { recursive: true, force: true });
  }
}

test('oasis -p waits out a Gemini per-minute limit on the same model when there is no backup', async () => {
  const run = await runAgainstRateLimitedGemini({ fails: 2 });
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /Recovered\./);
  assert.deepEqual(run.models, ['gemini-3-flash', 'gemini-3-flash', 'gemini-3-flash']);
  assert.match(run.err, /\[rate limit\] Waiting 1s/);
});

test('with a backup model, a per-minute limit waits once and then falls back', async () => {
  const run = await runAgainstRateLimitedGemini({ fails: 2, fallback: 'gemini-3.1-flash-lite' });
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /Recovered\./);
  assert.deepEqual(run.models, ['gemini-3-flash', 'gemini-3-flash', 'gemini-3.1-flash-lite']);
});

test('the browser app fails fast on daily quota and waits out per-minute limits', async () => {
  const { chat, retryPlan } = await import('../app/core/providers.mjs');
  const minute = geminiQuota429('GenerateRequestsPerMinutePerProjectPerModel-FreeTier', 'Generate content requests per minute limit exceeded on Free Tier.', '0.2s', '0s');
  const daily = geminiQuota429('GenerateRequestsPerDayPerProjectPerModel-FreeTier', 'Generate content requests per day limit exceeded on Free Tier.', '21h11m1.6s', '76261s');
  assert.deepEqual(retryPlan(429, daily), { retryable: false });
  assert.deepEqual(retryPlan(429, minute), { retryable: true, retryAfterMs: 500 });
  assert.deepEqual(retryPlan(429, 'Too many requests'), { retryable: true });
  assert.deepEqual(retryPlan(503, ''), { retryable: true });
  assert.deepEqual(retryPlan(400, ''), { retryable: false });
  const config = { protocol: 'openai', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', apiKey: 'k', model: 'gemini-3-flash' };
  let calls = 0;
  const started = Date.now();
  const err = await chat(config, { messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => { calls++; return new Response(daily, { status: 429 }); } }).catch((e) => e);
  assert.equal(calls, 1, 'a daily quota is not retried');
  assert.ok(Date.now() - started < 1000);
  assert.equal(err.status, 429);
  calls = 0;
  const waits = [];
  const ok = await chat(config, { messages: [{ role: 'user', content: 'x' }], onRetry: (n, e) => waits.push(e.retryAfterMs), fetchImpl: async () => (++calls === 1 ? new Response(minute, { status: 429 }) : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200, headers: { 'content-type': 'application/json' } })) });
  assert.equal(ok.content, 'ok');
  assert.deepEqual(waits, [500]);
});

test('an input-tokens-per-minute limit switches later steps to the compact tool set', async () => {
  const http = await import('node:http');
  const { spawn } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const seen = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      seen.push({ tools: (body.tools || []).length, bytes: raw.length });
      if (seen.length === 1) {
        res.writeHead(429, { 'content-type': 'application/json' });
        res.end(geminiQuota429('GenerateContentInputTokensPerModelPerMinute-FreeTier', 'Generate content input tokens per minute limit exceeded on Free Tier.', '0.2s', '0s').replace('generate_content_free_tier_requests', 'generate_content_free_tier_input_token_count'));
        return;
      }
      const message = seen.length === 2
        ? { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'list_files', arguments: '{"path":"."}' } }] }
        : { role: 'assistant', content: 'Listed.' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'oasis-tpm-'));
  try {
    await fs.writeFile(path.join(home, 'a.txt'), 'x');
    const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1', OASIS_MODEL: 'gemma-4-31b-it', OASIS_API_KEY: '', OASIS_SANDBOX: '0', OASIS_STREAM: '0' };
    const child = spawn(process.execPath, [new URL('../src/cli.mjs', import.meta.url).pathname, '-p', 'list the files'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { err += c; });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.equal(code, 0, err);
    assert.match(out, /Listed\./);
    assert.equal(seen.length, 3);
    assert.match(err, /Switched to the compact tool set/);
    assert.ok(seen[2].tools < seen[0].tools, 'fewer tools after the limit: ' + JSON.stringify(seen));
    assert.ok(seen[2].tools > 0 && seen[2].bytes < seen[0].bytes * 0.8, JSON.stringify(seen));
  } finally {
    server.close();
    await fs.rm(home, { recursive: true, force: true });
  }
});


test('server errors right after a per-minute wait still get their retries', async () => {
  const run = await runAgainstRateLimitedGemini({ fails: 1, serverErrors: 2 });
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /Recovered\./);
  assert.equal(run.models.length, 4);
});

test('three server errors in a row no longer fail the task', async () => {
  const run = await runAgainstRateLimitedGemini({ fails: 0, serverErrors: 3 });
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /Recovered\./);
  assert.equal(run.models.length, 4);
});

test('longer provider retries are announced instead of looking like a hang', async () => {
  const run = await runAgainstRateLimitedGemini({ fails: 0, serverErrors: 4 });
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /Recovered\./);
  assert.match(run.err, /\[retry\] Provider error 50\d.*retrying in \d+s \(4\/8\)/);
});

test('error advice fits the error: a used-up daily quota is not blamed on the endpoint', async () => {
  const { apiErrorAdvice } = await import('../src/agent.mjs');
  const daily = apiErrorAdvice(429, 'Generate content requests per day limit exceeded on Free Tier.\nPlease retry in 18h12m2.339487691s');
  assert.match(daily, /daily request quota/);
  assert.match(daily, /18h12m/);
  assert.doesNotMatch(daily, /endpoint|tool-calling/);
  assert.match(apiErrorAdvice(429, 'Too many requests'), /rate-limiting/);
  assert.match(apiErrorAdvice(401, 'bad key'), /API key/);
  assert.match(apiErrorAdvice(400, 'bad request'), /tool-calling support/);
});

test('a per-minute token limit is described as one, not as a billing problem', async () => {
  const { apiErrorAdvice } = await import('../src/agent.mjs');
  const advice = apiErrorAdvice(429, 'Quota exceeded for metric: generate_content_free_tier_input_token_count, limit: 16000, description: Generate content input tokens per minute limit exceeded on Free Tier. Please retry in 59.3s');
  assert.match(advice, /per-minute token limit/);
  assert.doesNotMatch(advice, /billing/);
});
