import test from 'node:test';
import assert from 'node:assert/strict';
import { discoverLocalOllamaModels } from '../src/ollama-discovery.mjs';

test('Ollama discovery queries only the fixed localhost endpoint and returns model names', async () => {
  let calledUrl = '';
  let calledOptions;
  const result = await discoverLocalOllamaModels({
    timeoutMs: 700,
    fetchImpl: async (url, options) => {
      calledUrl = String(url);
      calledOptions = options;
      return new Response(JSON.stringify({
        models: [
          { name: 'qwen2.5-coder:3b', digest: 'ignored' },
          { model: 'llama3.2:1b', modified_at: 'ignored' },
          { name: 'qwen2.5-coder:3b' },
          { name: '' }
        ]
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
  });
  assert.equal(calledUrl, 'http://127.0.0.1:11434/api/tags');
  assert.equal(calledOptions.method, 'GET');
  assert.equal(calledOptions.redirect, 'error');
  assert.ok(calledOptions.signal instanceof AbortSignal);
  assert.deepEqual(result, {
    available: true,
    models: ['qwen2.5-coder:3b', 'llama3.2:1b'],
    message: 'Ollama is running. Choose an installed model, then test the connection.'
  });
});

test('Ollama discovery caps model lists at 100', async () => {
  const result = await discoverLocalOllamaModels({
    fetchImpl: async () => new Response(JSON.stringify({
      models: Array.from({ length: 120 }, (_, index) => ({ name: 'model-' + index }))
    }), { status: 200 })
  });
  assert.equal(result.available, true);
  assert.equal(result.models.length, 100);
  assert.equal(result.models[99], 'model-99');
});

test('Ollama discovery gives a useful message when the service is present but has no models', async () => {
  const result = await discoverLocalOllamaModels({
    fetchImpl: async () => new Response(JSON.stringify({ models: [] }), { status: 200 })
  });
  assert.equal(result.available, true);
  assert.deepEqual(result.models, []);
  assert.match(result.message, /no models are installed yet/i);
});

test('Ollama discovery handles unavailable or failed services without leaking low-level errors', async () => {
  const unavailable = await discoverLocalOllamaModels({
    fetchImpl: async () => new Response('not found', { status: 404 })
  });
  assert.equal(unavailable.available, false);
  assert.deepEqual(unavailable.models, []);
  assert.match(unavailable.message, /Install it from ollama\.com\/download/);

  const failed = await discoverLocalOllamaModels({
    fetchImpl: async () => { throw new Error('secret internal network path'); }
  });
  assert.equal(failed.available, false);
  assert.deepEqual(failed.models, []);
  assert.doesNotMatch(failed.message, /secret internal network path/);
});
