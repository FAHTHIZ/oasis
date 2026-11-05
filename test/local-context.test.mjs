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
  assert.match(tool, /shortened this .*8,192-token context window/);
  assert.match(tool, /line 0/);
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
  // Loopback servers are not probed by default, and the probe can be turned off.
  assert.equal(await probeProviderModelWindow({ baseURL: 'http://127.0.0.1:8000/v1', model: 'm' }, { fetchImpl, env: {}, cache: false }), 0);
  assert.equal(await probeProviderModelWindow({ baseURL: 'https://api.example.test/v1', model: 'm' }, { fetchImpl, env: { OASIS_MODEL_INFO_PROBE: '0' }, cache: false }), 0);
  assert.equal(seen.length, 1);
});

test('DeepSeek V4 models get the 1M window', async () => {
  const { modelContextWindow } = await import('../src/context.mjs');
  assert.equal(modelContextWindow('deepseek-v4-pro'), 1_048_576);
  assert.equal(modelContextWindow('deepseek-flash'), 1_048_576);
  assert.equal(modelContextWindow('deepseek-chat'), 128_000);
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
