import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { isOllamaEndpoint, probeOllamaContext, SMALL_CONTEXT_TOOLS } from '../src/local-context.mjs';
import { compactionThresholdChars, contextWindowSize } from '../src/context.mjs';
import { createSession, closeSession } from '../src/agent.mjs';

// Minimal Ollama: /api/ps, /api/show and the OpenAI-compatible base.
async function fakeOllama(t, { loaded = 4096, modelfile = '', native = 131072, running = true } = {}) {
  const seen = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push(req.method + ' ' + req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: running ? [{ name: 'qwen3:8b', model: 'qwen3:8b', context_length: loaded }] : [] }));
    if (req.url === '/api/show') {
      assert.equal(JSON.parse(body).model, 'qwen3:8b');
      return res.end(JSON.stringify({ parameters: modelfile, model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': native } }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', seen };
}

test('Ollama endpoints are recognized by port, host name or explicit opt-in', () => {
  assert.equal(isOllamaEndpoint({ baseURL: 'http://localhost:11434/v1' }, {}), true);
  assert.equal(isOllamaEndpoint({ baseURL: 'https://ollama.internal.example/v1' }, {}), true);
  assert.equal(isOllamaEndpoint({ baseURL: 'http://127.0.0.1:8080/v1' }, { OASIS_OLLAMA: '1' }), true);
  assert.equal(isOllamaEndpoint({ baseURL: 'https://api.openai.com/v1' }, {}), false);
  assert.equal(isOllamaEndpoint({ baseURL: 'http://localhost:11434/v1', protocol: 'anthropic' }, {}), false);
});

test('the loaded context wins over the Modelfile, which wins over unknown', async (t) => {
  const loaded = await fakeOllama(t, { loaded: 8192, modelfile: 'num_ctx 16384' });
  assert.deepEqual(await probeOllamaContext({ baseURL: loaded.baseURL, model: 'qwen3:8b' }, { cache: false }), { contextLength: 8192, source: 'loaded', loaded: true, nativeContext: 131072 });
  const modelfile = await fakeOllama(t, { running: false, modelfile: 'temperature 0.6\nnum_ctx 16384' });
  assert.equal((await probeOllamaContext({ baseURL: modelfile.baseURL, model: 'qwen3:8b' }, { cache: false })).contextLength, 16384);
  const unknown = await fakeOllama(t, { running: false });
  assert.deepEqual(await probeOllamaContext({ baseURL: unknown.baseURL, model: 'qwen3:8b' }, { cache: false }), { contextLength: 0, source: 'unknown', loaded: false, nativeContext: 131072 });
  assert.equal(await probeOllamaContext({ baseURL: 'http://127.0.0.1:9/v1', model: 'qwen3:8b' }, { cache: false }), null);
});

test('small context windows compact earlier than the default window', () => {
  assert.equal(compactionThresholdChars({ contextWindow: 32_768 }, {}), 60_000);
  assert.equal(compactionThresholdChars({ contextWindow: 8192 }, {}), 14_745);
  assert.equal(compactionThresholdChars({ contextWindow: 4096 }, {}), 10_000);
});

test('a session on a 4K Ollama window uses the real window, small tool set and a fix-it notice', async (t) => {
  const ollama = await fakeOllama(t, { loaded: 4096 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-local-ctx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = { protocol: 'openai-compatible', baseURL: ollama.baseURL, model: 'qwen3:8b', apiKey: '' };
  const session = await createSession({ root, config, env: { ...process.env, OASIS_OLLAMA: '1' } });
  t.after(() => closeSession(session));
  assert.equal(contextWindowSize(session.config, {}), 4096);
  assert.equal(config.contextWindow, undefined, 'the caller config object is not mutated');
  const names = session.toolDefinitions.map((tool) => tool.function.name);
  assert.ok(names.every((name) => SMALL_CONTEXT_TOOLS.includes(name)), names.join(', '));
  assert.ok(names.includes('edit_file') && names.includes('run_command') && names.includes('tool_search'));
  assert.ok(session.deferredTools.has('task'));
  assert.match(session.localContextNotices[0], /4,096-token context window.*OLLAMA_CONTEXT_LENGTH=32768/);
});

test('an explicit context window skips the probe entirely', async (t) => {
  const ollama = await fakeOllama(t, { loaded: 4096 });
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-local-ctx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: ollama.baseURL, model: 'qwen3:8b', apiKey: '', contextWindow: 65536 }, env: { ...process.env, OASIS_OLLAMA: '1' } });
  t.after(() => closeSession(session));
  assert.equal(ollama.seen.length, 0);
  assert.equal(contextWindowSize(session.config, {}), 65536);
  assert.ok(session.toolDefinitions.length > SMALL_CONTEXT_TOOLS.length);
});

test('long tool results are shortened to fit a small window, keeping head and tail', async (t) => {
  const { scriptedModel } = await import('./helpers/scripted-model.mjs');
  const { writeFile } = await import('node:fs/promises');
  const { runAgentTurn } = await import('../src/agent.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-local-ctx-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lines = Array.from({ length: 2000 }, (_, i) => 'line ' + i);
  await writeFile(path.join(root, 'big.txt'), lines.join('\n'));
  const { config, requests } = await scriptedModel(t, [
    { content: null, tool_calls: [{ id: 'r1', type: 'function', function: { name: 'read_file', arguments: '{"path":"big.txt"}' } }] },
    { content: 'read it' }
  ]);
  const session = await createSession({ root, config: { ...config, contextWindow: 8192 }, permissionMode: 'bypassPermissions' });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'read big.txt', { approval: async () => true });
  const tool = requests[1].messages.find((m) => m.role === 'tool').content;
  assert.ok(tool.length <= Math.floor(8192 * 4 * 0.2), String(tool.length));
  // A file read is cut at a whole line with where to continue.
  assert.match(tool, /Continue with read_file offset=\d+/);
  assert.match(tool, /line 0/);
  assert.doesNotMatch(tool, /\[Tool result truncated\.\]/);
});

async function jsonServer(t, routes) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push(req.method + ' ' + req.url);
    res.setHeader('content-type', 'application/json');
    if (routes[req.url]) return res.end(JSON.stringify(routes[req.url]));
    res.statusCode = 404;
    res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', seen };
}

test('LM Studio and llama-server report their loaded windows', async (t) => {
  const { probeLocalContext } = await import('../src/local-context.mjs');
  const env = { OASIS_LOCAL_CONTEXT_PROBE: '1' };
  const lmstudio = await jsonServer(t, { '/api/v0/models': { data: [{ id: 'qwen/qwen3-8b', state: 'loaded', loaded_context_length: 8192, max_context_length: 131072 }] } });
  const lm = await probeLocalContext({ baseURL: lmstudio.baseURL, model: 'qwen/qwen3-8b' }, { env, cache: false });
  assert.deepEqual(lm, { contextLength: 8192, source: 'loaded', loaded: true, nativeContext: 131072, server: 'lmstudio' });
  const v1 = await jsonServer(t, { '/api/v1/models': { models: [{ key: 'qwen/qwen3-8b', max_context_length: 131072, loaded_instances: [{ config: { context_length: 16384 } }, { config: { context_length: 12000 } }] }] } });
  assert.equal((await probeLocalContext({ baseURL: v1.baseURL, model: 'qwen/qwen3-8b' }, { env, cache: false })).contextLength, 12000);
  const llama = await jsonServer(t, { '/props': { default_generation_settings: { n_ctx: 4096 } } });
  const ll = await probeLocalContext({ baseURL: llama.baseURL, model: 'model.gguf' }, { env, cache: false });
  assert.equal(ll.contextLength, 4096);
  assert.equal(ll.server, 'llama.cpp');
});

test('unrelated loopback ports are never probed without opt-in', async (t) => {
  const { probeLocalContext, isLocalModelEndpoint } = await import('../src/local-context.mjs');
  const other = await jsonServer(t, {});
  assert.equal(isLocalModelEndpoint({ baseURL: other.baseURL }, {}), false);
  assert.equal(isLocalModelEndpoint({ baseURL: 'http://localhost:1234/v1' }, {}), true);
  assert.equal(isLocalModelEndpoint({ baseURL: 'http://localhost:8080/v1' }, {}), true);
  assert.equal(isLocalModelEndpoint({ baseURL: 'https://example.com:1234/v1' }, {}), false);
  assert.equal(await probeLocalContext({ baseURL: other.baseURL, model: 'm' }, { env: {}, cache: false }), null);
  assert.deepEqual(other.seen, []);
});

test('provider overflow errors are recognised and their stated window is read', async () => {
  const { isContextOverflowError, contextWindowFromError } = await import('../src/agent.mjs');
  const llama = Object.assign(new Error('HTTP 400: request (16695 tokens) exceeds the available context size (16384 tokens), try increasing it'), { status: 400 });
  assert.equal(isContextOverflowError(llama), true);
  assert.equal(contextWindowFromError(llama), 16384);
  assert.equal(contextWindowFromError(new Error("This model's maximum context length is 8192 tokens. However, you requested 9000")), 8192);
  assert.equal(contextWindowFromError(new Error('maximum model length is 4096')), 4096);
  assert.equal(contextWindowFromError(new Error('rate limited')), 0);
});

test('unknown hosted models take their window from the provider /models listing', async () => {
  const { modelWindowFromListing, probeProviderModelWindow } = await import('../src/local-context.mjs');
  assert.equal(modelWindowFromListing({ data: [{ id: 'deepseek-flash', context_window: 1048576 }] }, 'deepseek-flash'), 1048576);
  assert.equal(modelWindowFromListing({ data: [{ id: 'acme/coder-9', context_length: 262144 }] }, 'acme/coder-9'), 262144);
  assert.equal(modelWindowFromListing({ data: [{ id: 'Qwen/Qwen3-32B', max_model_len: 40960 }] }, 'qwen/qwen3-32b'), 40960);
  assert.equal(modelWindowFromListing({ data: [{ id: 'other', context_window: 9999 }] }, 'missing'), 0);
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, auth: init.headers.authorization }); return { ok: true, json: async () => ({ data: [{ id: 'mystery-model', context_length: 65536 }] }) }; };
  const window = await probeProviderModelWindow({ protocol: 'openai-compatible', baseURL: 'https://api.example.test/v1/', model: 'mystery-model', apiKey: 'k1' }, { fetchImpl, env: {}, cache: false });
  assert.equal(window, 65536);
  assert.deepEqual(seen, [{ url: 'https://api.example.test/v1/models', auth: 'Bearer k1' }]);
  // A gateway on loopback (FreeLLMAPI, OmniRoute, LiteLLM, vLLM) lists windows
  // like a hosted provider and is asked too; local model servers have their own
  // probe and are skipped here, as is any other loopback port (often a dev
  // server). The probe can be turned off.
  assert.equal(await probeProviderModelWindow({ baseURL: 'http://127.0.0.1:3001/v1', model: 'mystery-model' }, { fetchImpl, env: {}, cache: false }), 65536);
  assert.equal(seen[1].url, 'http://127.0.0.1:3001/v1/models');
  assert.equal(await probeProviderModelWindow({ baseURL: 'http://127.0.0.1:1234/v1', model: 'mystery-model' }, { fetchImpl, env: {}, cache: false }), 0);
  assert.equal(await probeProviderModelWindow({ baseURL: 'http://127.0.0.1:5173/v1', model: 'mystery-model' }, { fetchImpl, env: {}, cache: false }), 0);
  assert.equal(await probeProviderModelWindow({ baseURL: 'http://127.0.0.1:11434/v1', model: 'mystery-model' }, { fetchImpl, env: {}, cache: false }), 0);
  assert.equal(await probeProviderModelWindow({ baseURL: 'https://api.example.test/v1', model: 'm' }, { fetchImpl, env: { OASIS_MODEL_INFO_PROBE: '0' }, cache: false }), 0);
  assert.equal(seen.length, 2);
});

test('DeepSeek V4 models get the 1M window', async () => {
  const { modelContextWindow } = await import('../src/context.mjs');
  assert.equal(modelContextWindow('deepseek-v4-pro'), 1_048_576);
  assert.equal(modelContextWindow('deepseek-flash'), 1_048_576);
});

test('small context windows get a compact system prompt; normal windows keep the full one', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-compact-prompt-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = { protocol: 'openai-compatible', baseURL: 'https://api.example.test/v1', model: 'fixture', apiKey: '' };
  const small = await createSession({ root, config: { ...base, contextWindow: 8192 }, env: { ...process.env, OASIS_MODEL_INFO_PROBE: '0' } });
  const large = await createSession({ root, config: { ...base, contextWindow: 200000 }, env: { ...process.env, OASIS_MODEL_INFO_PROBE: '0' } });
  t.after(() => { closeSession(small); closeSession(large); });
  const smallPrompt = small.messages[0].content;
  const largePrompt = large.messages[0].content;
  assert.match(smallPrompt, /Read a file before editing it/);
  assert.match(smallPrompt, /Never claim a test passed/);
  assert.doesNotMatch(smallPrompt, /use delegate_openhands|use setup_omniroute|launch a bounded wave/);
  assert.match(largePrompt, /How to work:[\s\S]*Delegate broad exploration/);
  assert.ok(smallPrompt.length < largePrompt.length * 0.75, smallPrompt.length + ' vs ' + largePrompt.length);
});

test('connect gives an Ollama model with a small default window a wide variant that shares its weights', async () => {
  const { widenOllamaContext, ollamaWideModelName } = await import('../src/local-context.mjs');
  assert.equal(ollamaWideModelName('qwen2.5-coder:3b'), 'qwen2.5-coder:3b-oasis');
  assert.equal(ollamaWideModelName('library/llama3.2'), 'library/llama3.2:latest-oasis');
  assert.equal(ollamaWideModelName('host:5000/team/model'), 'host:5000/team/model:latest-oasis');
  const created = [];
  const fetchImpl = async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : {};
    if (url.endsWith('/api/ps')) return Response.json({ models: [{ name: 'qwen2.5-coder:3b', context_length: 4096 }] });
    if (url.endsWith('/api/show')) return Response.json({ model_info: { 'qwen2.context_length': 32768 }, parameters: '' });
    if (url.endsWith('/api/create')) { created.push(body); return Response.json({ status: 'success' }); }
    return new Response('no', { status: 404 });
  };
  const statuses = [];
  const config = { protocol: 'openai-compatible', baseURL: 'http://localhost:11434/v1', model: 'qwen2.5-coder:3b' };
  const wide = await widenOllamaContext(config, { fetchImpl, onStatus: (status) => statuses.push(status.text) });
  assert.deepEqual(wide, { model: 'qwen2.5-coder:3b-oasis', contextLength: 32768, from: 'qwen2.5-coder:3b' });
  assert.deepEqual(created, [{ model: 'qwen2.5-coder:3b-oasis', from: 'qwen2.5-coder:3b', parameters: { num_ctx: 32768 }, stream: false }]);
  assert.match(statuses[0], /4,096-token window.*Created qwen2\.5-coder:3b-oasis.*32,768-token window/);
  // Never for a variant, a model already loaded wide, a model whose own maximum is small, or a hosted endpoint.
  assert.equal(await widenOllamaContext({ ...config, model: 'qwen2.5-coder:3b-oasis' }, { fetchImpl }), null);
  const wideServer = async (url, init) => url.endsWith('/api/ps') ? Response.json({ models: [{ name: 'qwen2.5-coder:3b', context_length: 65536 }] }) : fetchImpl(url, init);
  assert.equal(await widenOllamaContext(config, { fetchImpl: wideServer }), null);
  const tinyModel = async (url, init) => url.endsWith('/api/show') ? Response.json({ model_info: { 'llama.context_length': 8192 } }) : fetchImpl(url, init);
  assert.equal(await widenOllamaContext(config, { fetchImpl: tinyModel }), null);
  assert.equal(await widenOllamaContext({ ...config, baseURL: 'https://api.openai.com/v1' }, { fetchImpl }), null);
  const refused = async (url, init) => url.endsWith('/api/create') ? new Response('denied', { status: 403 }) : fetchImpl(url, init);
  assert.equal(await widenOllamaContext(config, { fetchImpl: refused }), null, 'a refused create leaves the original model in place');
  assert.equal(created.length, 1);
});

// Regression: on an 8 GB, 2-core machine `oasis connect` made a 32K variant of
// qwen3:0.6b that Ollama loaded at 4.4 GB, past the 3.3 GB model budget that
// `oasis setup --auto` uses (and slow enough to stall a terminal session).
test('the wide Ollama variant is sized to fit this computer\'s model memory', async () => {
  const { widenOllamaContext, kvCacheBytesPerToken, fittingContext } = await import('../src/local-context.mjs');
  const info = { 'qwen3.block_count': 28, 'qwen3.attention.head_count': 16, 'qwen3.attention.head_count_kv': 8, 'qwen3.attention.key_length': 128, 'qwen3.attention.value_length': 128, 'qwen3.context_length': 40960, 'qwen3.embedding_length': 1024 };
  assert.equal(kvCacheBytesPerToken(info), 114688);
  assert.equal(kvCacheBytesPerToken({}), 0);
  assert.equal(fittingContext({ target: 32768, nativeContext: 40960, kvBytesPerToken: 114688, weightsBytes: 522653767, budgetGB: 3.3 }), 24576);
  assert.equal(fittingContext({ target: 32768, nativeContext: 40960, kvBytesPerToken: 114688, weightsBytes: 522653767, budgetGB: 9.6 }), 32768);
  assert.equal(fittingContext({ target: 32768, nativeContext: 40960, kvBytesPerToken: 114688, weightsBytes: 522653767, budgetGB: 1 }), 16384);
  assert.equal(fittingContext({ target: 32768, nativeContext: 40960, kvBytesPerToken: 0, budgetGB: 1 }), 32768, 'unknown cache size keeps the old behaviour');
  const created = [];
  const fetchImpl = async (url, init = {}) => {
    if (url.endsWith('/api/ps')) return Response.json({ models: [] });
    if (url.endsWith('/api/show')) return Response.json({ model_info: info, parameters: '' });
    if (url.endsWith('/api/tags')) return Response.json({ models: [{ name: 'qwen3:0.6b', size: 522653767 }] });
    if (url.endsWith('/api/create')) { created.push(JSON.parse(init.body)); return Response.json({ status: 'success' }); }
    return new Response('no', { status: 404 });
  };
  const statuses = [];
  const config = { protocol: 'openai-compatible', baseURL: 'http://localhost:11434/v1', model: 'qwen3:0.6b' };
  const wide = await widenOllamaContext(config, { fetchImpl, memoryBudgetGB: 3.3, onStatus: (status) => statuses.push(status.text) });
  assert.equal(wide.contextLength, 24576);
  assert.equal(created[0].parameters.num_ctx, 24576);
  assert.match(statuses[0], /24,576-token window, sized to fit about 3\.3 GB of model memory on this computer \(32,768 would not fit\)/);
});
