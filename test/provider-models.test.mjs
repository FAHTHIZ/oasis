import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listProviderModels, parseModelList, modelsEndpoint, clearProviderModelCache } from '../src/provider-models.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

async function server(t, handler) {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push({ url: req.url, headers: req.headers }); handler(req, res); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  t.after(() => srv.close());
  return { base: 'http://127.0.0.1:' + srv.address().port, seen };
}

test('model list parsing accepts OpenAI, Anthropic, Ollama and Gemini shapes', () => {
  assert.deepEqual(parseModelList({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }, { id: 'gpt-a' }] }), ['gpt-a', 'gpt-b']);
  assert.deepEqual(parseModelList({ models: [{ name: 'models/gemini-x' }, { name: 'llama3:8b' }] }), ['gemini-x', 'llama3:8b']);
  assert.deepEqual(parseModelList({ data: [{ id: 'ok' }, { id: 'bad name; rm -rf' }, { id: 5 }] }), ['ok']);
  assert.equal(modelsEndpoint({ protocol: 'anthropic', baseURL: 'https://api.anthropic.com' }), 'https://api.anthropic.com/v1/models?limit=1000');
  assert.equal(modelsEndpoint({ protocol: 'openai-compatible', baseURL: 'https://api.openai.com/v1/chat/completions' }), 'https://api.openai.com/v1/models');
  assert.equal(modelsEndpoint({ protocol: 'bedrock', baseURL: 'https://x' }), null);
});

test('listing uses the configured key and reports failures without throwing', async (t) => {
  clearProviderModelCache();
  const ok = await server(t, (req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }] })); });
  const listed = await listProviderModels({ protocol: 'openai-compatible', baseURL: ok.base + '/v1', apiKey: 'sk-test' });
  assert.deepEqual(listed.models, ['m1', 'm2']);
  assert.equal(ok.seen[0].url, '/v1/models');
  assert.equal(ok.seen[0].headers.authorization, 'Bearer sk-test');
  const anth = await server(t, (req, res) => res.end(JSON.stringify({ data: [{ id: 'claude-x' }] })));
  await listProviderModels({ protocol: 'anthropic', baseURL: anth.base, apiKey: 'ak' });
  assert.equal(anth.seen[0].headers['x-api-key'], 'ak');
  assert.equal(anth.seen[0].headers['anthropic-version'], '2023-06-01');
  const denied = await server(t, (req, res) => { res.statusCode = 401; res.end('{}'); });
  const failed = await listProviderModels({ protocol: 'openai-compatible', baseURL: denied.base });
  assert.equal(failed.models, null);
  assert.match(failed.reason, /HTTP 401/);
  const slow = await server(t, () => {});
  const timedOut = await listProviderModels({ protocol: 'openai-compatible', baseURL: slow.base }, { timeoutMs: 600 });
  assert.match(timedOut.reason, /did not answer/);
});

test('/model --list shows served models and respects availableModels', async (t) => {
  clearProviderModelCache();
  const srv = await server(t, (req, res) => res.end(JSON.stringify({ data: [{ id: 'gpt-allowed' }, { id: 'gpt-blocked' }] })));
  const session = { root: process.cwd(), config: { protocol: 'openai-compatible', baseURL: srv.base + '/v1', model: 'gpt-allowed' }, availableModels: ['gpt-allowed'] };
  const result = await runBuiltinCommand('model', '--list', { root: process.cwd(), session, env: process.env, sessionOptions: {} });
  assert.match(result.output, /serves 2 models \(1 hidden by availableModels\)/);
  assert.match(result.output, /\* gpt-allowed/);
  assert.doesNotMatch(result.output, /gpt-blocked/);
});

test('a gateway list larger than 500 models keeps the models late in the alphabet', () => {
  const data = [];
  for (let i = 0; i < 900; i++) data.push({ id: 'aaa/model-' + String(i).padStart(4, '0') });
  data.push({ id: 'x-ai/grok-5' }, { id: 'z-ai/glm-5' });
  const ids = parseModelList({ data });
  assert.equal(ids.length, 902);
  assert.ok(ids.includes('x-ai/grok-5') && ids.includes('z-ai/glm-5'));
});
