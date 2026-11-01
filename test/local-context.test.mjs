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
