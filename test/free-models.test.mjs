import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { agentScore, annotateFreeModels, discoverFreeModels, parameterBillions, parseOpenRouterFree, rankFreeModels, withFreeFallbacks } from '../src/free-models.mjs';
import { modelsCommand } from '../src/models-command.mjs';
import { quotaRoute, recordFailure } from '../src/quota-ledger.mjs';
import { parseFallbackChain } from '../src/fallback-chain.mjs';

const NOW = Date.parse('2026-11-22T00:00:00Z');
const day = 24 * 3600;
const entry = (id, extra = {}) => ({
  id, name: id, created: NOW / 1000 - 30 * day, context_length: 262144,
  architecture: { input_modalities: ['text'], output_modalities: ['text'] },
  pricing: { prompt: '0', completion: '0' },
  supported_parameters: ['tools', 'tool_choice', 'max_tokens'],
  top_provider: { context_length: 262144, max_completion_tokens: 32768 },
  ...extra
});
const CATALOG = { data: [
  entry('big/model-120b:free', { supported_parameters: ['tools', 'structured_outputs', 'reasoning'] }),
  entry('tiny/model-1.7b:free'),
  entry('mid/model-31b-it:free', { architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] } }),
  entry('paid/model-70b', { pricing: { prompt: '0.0000002', completion: '0.0000006' } }),
  entry('paid/request-fee:free', { pricing: { prompt: '0', completion: '0', request: '0.01' } }),
  entry('notools/model-70b:free', { supported_parameters: ['max_tokens'] }),
  entry('short/model-70b:free', { context_length: 8192, top_provider: { context_length: 8192 } }),
  entry('music/lyria:free', { architecture: { output_modalities: ['audio'] } }),
  entry('leaving/model-70b:free', { expiration_date: '2026-11-25' }),
  entry('openrouter/free', { context_length: 200000 }),
  { id: 'bad id with spaces', pricing: { prompt: '0' } }
] };

test('only free, text, tool-calling models with a usable context are kept', () => {
  const ids = parseOpenRouterFree(CATALOG, { now: NOW }).map((model) => model.id).sort();
  assert.deepEqual(ids, ['big/model-120b:free', 'mid/model-31b-it:free', 'openrouter/free', 'tiny/model-1.7b:free']);
  const mid = parseOpenRouterFree(CATALOG, { now: NOW }).find((model) => model.id === 'mid/model-31b-it:free');
  assert.equal(mid.spec, 'openrouter:mid/model-31b-it:free');
  assert.equal(mid.vision, true);
  assert.equal(mid.billions, 31);
});

test('ranking puts capable models first, tiny ones and the router last', () => {
  assert.equal(parameterBillions('nvidia/nemotron-3-ultra-550b-a55b:free'), 550);
  assert.equal(parameterBillions('liquid/lfm-3-1.7b:free'), 1.7);
  assert.equal(parameterBillions('google/gemma-4-31b-it:free'), 31);
  assert.equal(parameterBillions('inclusionai/ling-3.2-flash:free'), 0);
  const ranked = rankFreeModels(parseOpenRouterFree(CATALOG, { now: NOW }), { now: NOW }).map((model) => model.id);
  assert.deepEqual(ranked, ['big/model-120b:free', 'mid/model-31b-it:free', 'tiny/model-1.7b:free', 'openrouter/free']);
  assert.ok(agentScore({ tools: false }) < agentScore({ tools: true, router: true }));
});

test('applying appends new free entries the fallback chain can parse', () => {
  const ranked = rankFreeModels(parseOpenRouterFree(CATALOG, { now: NOW }), { now: NOW });
  const { chain, added } = withFreeFallbacks('anthropic:claude-haiku-5, openrouter:big/model-120b:free', ranked, 2);
  assert.deepEqual(added, ['openrouter:mid/model-31b-it:free', 'openrouter:tiny/model-1.7b:free']);
  assert.equal(chain.length, 4);
  const parsed = parseFallbackChain(chain.join(','));
  assert.deepEqual(parsed.at(-2), { id: 'openrouter:mid/model-31b-it:free', provider: 'openrouter', model: 'mid/model-31b-it:free' });
  assert.equal(withFreeFallbacks(chain, ranked, 3).added.length, 0, 'the router is never added');
});

function fakeFetch({ ollama = true, openrouter = true } = {}) {
  return async (url, init = {}) => {
    const reply = (status, body) => ({ ok: status === 200, status, text: async () => JSON.stringify(body), json: async () => body });
    if (url.startsWith('https://openrouter.ai/')) return openrouter ? reply(200, CATALOG) : reply(503, {});
    if (url.endsWith('/api/tags')) { if (!ollama) throw new Error('ECONNREFUSED'); return reply(200, { models: [{ name: 'qwen3:8b' }, { name: 'llama2:7b' }, { name: 'nomic-embed-text' }] }); }
    if (url.endsWith('/api/show')) {
      const model = JSON.parse(init.body).model;
      return reply(200, { capabilities: model === 'qwen3:8b' ? ['completion', 'tools'] : ['completion'], model_info: { 'qwen3.context_length': 40960 } });
    }
    throw new Error('unexpected ' + url);
  };
}

test('discovery adds tool-capable local Ollama models and names sources that failed', async () => {
  const found = await discoverFreeModels({ fetchImpl: fakeFetch({ openrouter: false }), now: NOW });
  assert.deepEqual(found.models.map((model) => model.spec), ['ollama:qwen3:8b']);
  assert.equal(found.models[0].context, 40960);
  assert.equal(found.ollama, true);
  assert.match(found.errors[0], /^OpenRouter: HTTP 503/);
  const both = await discoverFreeModels({ fetchImpl: fakeFetch(), now: NOW });
  assert.ok(both.models.some((model) => model.source === 'ollama') && both.models.some((model) => model.source === 'openrouter'));
});

test('oasis models free lists the models and --apply writes the fallback chain', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-free-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, OASIS_CONFIG_DIR: path.join(home, 'config'), OPENROUTER_API_KEY: '' };
  const out = [];
  const stdout = { write: (text) => out.push(text) };
  const stderr = { write: (text) => out.push(text) };
  assert.equal(await modelsCommand(['free', '--cloud-only'], { env, stdout, stderr, fetchImpl: fakeFetch() }), 0);
  const text = out.join('');
  assert.match(text, /1 +openrouter:big\/model-120b:free +262K +120B/);
  assert.match(text, /need a free account key in OPENROUTER_API_KEY/);
  assert.doesNotMatch(text, /ollama:/);

  out.length = 0;
  assert.equal(await modelsCommand(['free', '--apply', '2', '--json'], { env, stdout, stderr, fetchImpl: fakeFetch(), memoryBudgetGB: 16 }), 0);
  const result = JSON.parse(out.join(''));
  assert.deepEqual(result.applied.added, ['openrouter:big/model-120b:free', 'ollama:qwen3:8b'], 'the local model is kept as the last resort');
  const settings = JSON.parse(await readFile(path.join(env.OASIS_CONFIG_DIR, 'settings.json'), 'utf8'));
  assert.equal(settings.fallbackModel, 'openrouter:big/model-120b:free,ollama:qwen3:8b');

  out.length = 0;
  assert.equal(await modelsCommand(['free', '--bogus'], { env, stdout, stderr, fetchImpl: fakeFetch() }), 2);
});

test('quota cooldowns move a model back and local models must fit in memory', () => {
  const ranked = rankFreeModels([
    { id: 'a/big:free', spec: 'openrouter:a/big:free', name: 'a/big:free', source: 'openrouter', tools: true, context: 131072, billions: 120 },
    { id: 'b/mid:free', spec: 'openrouter:b/mid:free', name: 'b/mid:free', source: 'openrouter', tools: true, context: 131072, billions: 30 },
    { id: 'qwen3:32b', spec: 'ollama:qwen3:32b', name: 'qwen3:32b', source: 'ollama', tools: true, context: 40960, billions: 32 },
    { id: 'qwen3:4b', spec: 'ollama:qwen3:4b', name: 'qwen3:4b', source: 'ollama', tools: true, context: 40960, billions: 4 }
  ], { now: NOW });
  const day = new Date(NOW).toISOString().slice(0, 10);
  const routes = [
    { provider: 'openrouter', model: 'a/big:free', day, requests: 48, cooldown: { until: NOW + 3600_000, source: 'provider', status: 429 } },
    { provider: 'openrouter', model: 'b/mid:free', day, requests: 3, cooldown: { until: NOW - 1000, source: 'guess', status: 429 } },
    { provider: 'api.other.example', model: 'b/mid:free', day, requests: 9, cooldown: { until: NOW + 3600_000, source: 'guess', status: 429 } }
  ];
  const annotated = annotateFreeModels(ranked, { routes, budgetGB: 8, now: NOW });
  const big = annotated.find((model) => model.id === 'a/big:free');
  assert.equal(annotated.at(-1), big, 'a model out of quota goes last');
  assert.equal(big.cooldown.source, 'provider');
  assert.equal(big.requestsToday, 48);
  const mid = annotated.find((model) => model.id === 'b/mid:free');
  assert.equal(mid.cooldown, undefined, 'an expired cooldown and another provider do not count');
  assert.equal(mid.requestsToday, 3);
  const large = annotated.find((model) => model.id === 'qwen3:32b');
  assert.equal(large.fits, false);
  assert.ok(large.needGB > 8);
  assert.equal(annotated.find((model) => model.id === 'qwen3:4b').fits, true);
  const applied = withFreeFallbacks('', annotated, 4);
  assert.ok(!applied.added.includes('ollama:qwen3:32b'), 'a local model too large for this computer is never added');
  assert.ok(applied.added.includes('ollama:qwen3:4b'));
  assert.equal(annotateFreeModels(ranked, { now: NOW }).find((model) => model.id === 'qwen3:32b').fits, undefined, 'unknown memory: no verdict');
});

test('oasis models free reads the quota ledger and this computer\'s memory', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-free-quota-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const env = { ...process.env, HOME: home, USERPROFILE: home, OASIS_CONFIG_DIR: path.join(home, 'config'), OPENROUTER_API_KEY: 'k' };
  recordFailure(quotaRoute({ fallbackProvider: 'openrouter', model: 'big/model-120b:free' }, 'k'), { status: 429, body: 'rate limit exceeded: free-models-per-day', headers: { 'retry-after': '7200' }, env });
  const out = [];
  const stdout = { write: (text) => out.push(text) };
  assert.equal(await modelsCommand(['free'], { env, stdout, stderr: stdout, fetchImpl: fakeFetch(), memoryBudgetGB: 3 }), 0);
  const text = out.join('');
  assert.match(text, /openrouter:big\/model-120b:free .*out of quota until \d\d:\d\d UTC/);
  assert.match(text, /ollama:qwen3:8b .*too large for this computer \(needs ~6 GB\)/);
  assert.match(text, /Models out of quota are listed last/);
  assert.match(text, /about 3 GB this computer can give a model/);
});

test('a local model whose KV cache is known is sized with a 16K window', () => {
  const base = { id: 'qwen3:4b', spec: 'ollama:qwen3:4b', source: 'ollama', name: 'qwen3:4b', billions: 4, score: 10 };
  const guessed = annotateFreeModels([base], { budgetGB: 4 })[0];
  assert.equal(guessed.needGB, 3.5);
  assert.equal(guessed.fits, true);
  // qwen3:4b: 36 layers x 8 KV heads x (128 + 128) x 2 bytes.
  const measured = annotateFreeModels([{ ...base, kvBytesPerToken: 147456 }], { budgetGB: 4 })[0];
  assert.ok(measured.needGB > 5 && measured.needGB < 5.5, String(measured.needGB));
  assert.equal(measured.fits, false, 'weights fit, but not with a usable context window');
});
