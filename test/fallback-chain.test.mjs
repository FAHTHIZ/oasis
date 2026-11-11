import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { parseFallbackChain, resolveFallbackConfig, fallbackReason, remainingFallbacks, describeFallbackChain } from '../src/fallback-chain.mjs';
import { createSession, closeSession, runAgentTurn, restorePrimaryModel } from '../src/agent.mjs';
import { runHeadless } from '../src/headless.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const tmp = () => mkdtemp(path.join(os.tmpdir(), 'oasis-fallback-'));

test('parses one model, a list, provider-qualified entries and Ollama tags', () => {
  assert.deepEqual(parseFallbackChain('backup'), [{ id: 'backup', provider: '', model: 'backup' }]);
  assert.deepEqual(parseFallbackChain(' a , b,,a ').map((e) => e.id), ['a', 'b']);
  const chain = parseFallbackChain('openrouter:qwen/qwen3-coder, ollama:qwen3:4b, qwen3:4b, Groq:llama-3.3-70b');
  assert.deepEqual(chain, [
    { id: 'openrouter:qwen/qwen3-coder', provider: 'openrouter', model: 'qwen/qwen3-coder' },
    { id: 'ollama:qwen3:4b', provider: 'ollama', model: 'qwen3:4b' },
    { id: 'qwen3:4b', provider: '', model: 'qwen3:4b' },
    { id: 'groq:llama-3.3-70b', provider: 'groq', model: 'llama-3.3-70b' }
  ]);
  assert.deepEqual(parseFallbackChain(['x', ' y ', '']).map((e) => e.id), ['x', 'y']);
  assert.deepEqual(parseFallbackChain(''), []);
});

test('resolves provider entries from their key variables and never reuses the main key', () => {
  const base = { protocol: 'anthropic', baseURL: 'https://api.anthropic.com', apiKey: 'sk-ant-main', model: 'claude', contextWindow: 200000, maxSteps: 9, apiKeyHelper: 'x' };
  assert.equal(resolveFallbackConfig({ provider: 'openrouter', model: 'm' }, base, {}), null, 'no key, skipped');
  const or = resolveFallbackConfig({ provider: 'openrouter', model: 'm' }, base, { OPENROUTER_API_KEY: 'sk-or-1' });
  assert.equal(or.apiKey, 'sk-or-1');
  assert.equal(or.baseURL, 'https://openrouter.ai/api/v1');
  assert.equal(or.protocol, 'openai-compatible');
  assert.equal(or.contextWindow, undefined, 'model-specific settings are dropped');
  assert.equal(or.apiKeyHelper, undefined);
  assert.equal(or.maxSteps, 9, 'session limits are kept');
  const local = resolveFallbackConfig({ provider: 'ollama', model: 'qwen3:4b' }, base, { OASIS_FALLBACK_OLLAMA_BASE_URL: 'http://10.0.0.5:11434/v1/' });
  assert.equal(local.apiKey, '');
  assert.equal(local.baseURL, 'http://10.0.0.5:11434/v1');
  const same = resolveFallbackConfig({ provider: '', model: 'claude-mini' }, base, {});
  assert.equal(same.apiKey, 'sk-ant-main');
  assert.equal(same.contextWindow, 200000);
  const described = describeFallbackChain(parseFallbackChain('a,gemini:g'), base, {});
  assert.equal(described[1].usable, false);
  assert.match(described[1].missing, /GEMINI_API_KEY/);
});

test('only failures another model can fix move down the chain', () => {
  const err = (status, message = '') => Object.assign(new Error(message || 'HTTP ' + status), { status });
  assert.equal(fallbackReason(err(402)), 'credits');
  assert.equal(fallbackReason(err(400, 'You exceeded your current quota')), 'credits');
  assert.equal(fallbackReason(err(429)), 'rate');
  assert.equal(fallbackReason(err(529, 'overloaded')), 'server');
  assert.equal(fallbackReason(err(503)), 'server');
  assert.equal(fallbackReason(new Error('fetch failed')), 'server');
  assert.equal(fallbackReason(err(404, 'model foo not found')), 'model');
  assert.equal(fallbackReason(err(400, 'No endpoints found that support tool use')), 'model');
  assert.equal(fallbackReason(err(400, 'invalid tool schema')), '');
  assert.equal(fallbackReason(err(400, 'maximum context length is 8192 tokens')), '');
  assert.equal(fallbackReason(err(402, 'Model provider returned HTTP 402: Insufficient credits. This is a billing or quota limit, not an API-key authentication failure.')), 'credits', 'credit text that mentions authentication is still credits');
  assert.equal(fallbackReason(err(0, 'OpenRouter does not have enough remaining credits. This is a credit limit, not an invalid API key.')), 'credits');
  assert.equal(fallbackReason(err(401)), '', 'a bad main key needs the user');
  assert.equal(fallbackReason(err(401), { onFallbackProvider: true }), 'auth');
  assert.equal(fallbackReason(Object.assign(new Error('aborted'), { name: 'AbortError' })), '');
  const chain = parseFallbackChain('a,b,openrouter:c');
  const base = { baseURL: 'https://x/v1', model: 'main', apiKey: 'k' };
  assert.deepEqual(remainingFallbacks(chain, { current: base, baseConfig: base, failed: new Set(['a']), env: {} }).map((r) => r.entry.id), ['b']);
});

function mockProvider(handler) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    seen.push({ model: payload.model, auth: req.headers.authorization || '' });
    const reply = handler(payload, req);
    if (reply.status) { res.statusCode = reply.status; res.end(JSON.stringify({ error: { message: reply.message || 'error' } })); return; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply.text } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, seen, url: 'http://127.0.0.1:' + server.address().port + '/v1' })));
}

test('a credit failure walks the chain, crosses to another provider and comes back after the cooldown', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  let mainBroke = true;
  const main = await mockProvider((payload) => {
    if (payload.model === 'main' && mainBroke) return { status: 402, message: 'Insufficient credits' };
    if (payload.model === 'mini') return { status: 429, message: 'rate limit' };
    return { text: 'main provider: ' + payload.model };
  });
  const other = await mockProvider((payload) => ({ text: 'other provider: ' + payload.model }));
  t.after(() => new Promise((resolve) => main.server.close(resolve)));
  t.after(() => new Promise((resolve) => other.server.close(resolve)));
  const env = { ...process.env, OASIS_FALLBACK_COOLDOWN_MINUTES: '0', GROQ_API_KEY: 'gsk-fallback', OASIS_FALLBACK_GROQ_BASE_URL: other.url, OASIS_API_KEY_POOL: 'pool-a,pool-b' };
  const switches = [];
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: main.url, model: 'main', apiKey: 'pool-a', maxSteps: 4 }, settings, fallbackModel: 'mini, gemini:no-key, groq:kimi', env });
  t.after(() => closeSession(session));
  const first = await runAgentTurn(session, 'one', { env, onFallback: (info) => switches.push(info.to) });
  assert.match(JSON.stringify(first), /other provider: kimi/);
  assert.deepEqual([...new Set(main.seen.map((s) => s.model))], ['main', 'mini']);
  assert.deepEqual(other.seen.map((s) => s.auth), ['Bearer gsk-fallback'], 'the fallback provider gets its own key, never a pool key');
  assert.equal(session.fallbackActive.kind, 'rate');
  assert.equal(session.fallbackActive.provider, 'groq');
  assert.ok(session.hookMessages.some((m) => /main ran out of credit/.test(m)));
  assert.ok(session.hookMessages.some((m) => /switched to groq:kimi/.test(m)));
  mainBroke = false;
  assert.equal(restorePrimaryModel(session, env), true);
  assert.equal(session.config.baseURL, main.url, 'the main provider is restored, not just the model name');
  assert.equal(session.config.model, 'main');
  assert.equal(session.config.fallbackProvider, undefined);
});

test('errors the next model cannot fix are not retried elsewhere', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = await mockProvider((payload) => payload.model === 'main' ? { status: 400, message: 'invalid tool schema' } : { text: 'backup' });
  t.after(() => new Promise((resolve) => main.server.close(resolve)));
  const config = { protocol: 'openai-compatible', baseURL: main.url, model: 'main', apiKey: '', maxSteps: 4 };
  const { summary } = await runHeadless({ prompt: 'hi', root, config, outputFormat: 'json', sessionOptions: { settings, fallbackModel: 'backup' }, write: () => {} });
  assert.notEqual(summary.result, 'backup');
  assert.deepEqual([...new Set(main.seen.map((s) => s.model))], ['main']);
});

test('a stream that keeps dropping after its restarts moves down the chain, a malformed tool call does not', () => {
  const dropped = Object.assign(new Error('The model stream was interrupted: the connection closed before the reply finished.'), { code: 'OASIS_STREAM_INTERRUPTED' });
  assert.equal(fallbackReason(dropped), 'server');
  const malformed = Object.assign(new Error('The model stream was interrupted: the model produced a malformed tool call (MALFORMED_FUNCTION_CALL).'), { code: 'OASIS_STREAM_INTERRUPTED', malformedCall: true });
  assert.equal(fallbackReason(malformed), '');
});

test('automatic fallback and the return after the cooldown run PostModelSwitch with source "auto"', async (t) => {
  const root = await tmp();
  t.after(() => rm(root, { recursive: true, force: true }));
  const main = await mockProvider((payload) => payload.model === 'main' ? { status: 402, message: 'Insufficient credits' } : { text: 'backup answered' });
  t.after(() => new Promise((resolve) => main.server.close(resolve)));
  const log = path.join(root, 'switches.jsonl');
  const hook = JSON.stringify(process.execPath) + ' -e ' + JSON.stringify('let s="";process.stdin.on("data",(c)=>s+=c);process.stdin.on("end",()=>require("fs").appendFileSync(' + JSON.stringify(log) + ',s.trim()+"\\n"))');
  const hooks = { PostModelSwitch: [{ hooks: [{ type: 'command', command: hook }] }] };
  const env = { ...process.env, OASIS_FALLBACK_COOLDOWN_MINUTES: '0' };
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: main.url, model: 'main', apiKey: 'k', maxSteps: 2 }, settings: { ...settings, hooks }, fallbackModel: 'backup', env });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'hi', { env });
  assert.match(JSON.stringify(result), /backup answered/);
  await session.pendingModelSwitch;
  assert.equal(restorePrimaryModel(session, env), true);
  await session.pendingModelSwitch;
  const { readFile } = await import('node:fs/promises');
  const inputs = (await readFile(log, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(inputs.map((input) => [input.hook_event_name, input.source, input.from_model, input.to_model, input.requested_model]), [
    ['PostModelSwitch', 'auto', 'main', 'backup', null],
    ['PostModelSwitch', 'auto', 'backup', 'main', null]
  ]);
});
