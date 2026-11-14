import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldPromptForProviderBaseURL, validateBaseUrl } from '../src/config.mjs';

test('only Custom provider setup asks the user for a Base URL', () => {
  for (const provider of ['openai', 'anthropic', 'openrouter', 'gemini', 'ollama', 'bedrock', 'vertex', 'foundry']) {
    assert.equal(shouldPromptForProviderBaseURL(provider), false, provider);
  }
  assert.equal(shouldPromptForProviderBaseURL('custom'), true);
});

test('Gemini model IDs are explained when accidentally entered as a provider URL', () => {
  assert.equal(validateBaseUrl('https://generativelanguage.googleapis.com/v1beta/openai/'),
    'https://generativelanguage.googleapis.com/v1beta/openai');
  assert.throws(
    () => validateBaseUrl('gemini-3.8-flash'),
    /model ID, not a provider URL.*Model name prompt/i
  );
});


test('setup names a hardware-fitting model when Ollama runs with no models', async () => {
  const { ollamaPullHint } = await import('../src/cli-setup.mjs');
  assert.match(await ollamaPullHint({ detect: async () => ({ memoryGB: 8 }) }), /ollama pull qwen3:4b\S* +\(fits this computer\)/);
  assert.match(await ollamaPullHint({ detect: async () => ({ memoryGB: 32, gpu: { vramGB: 24 } }) }), /ollama pull (?!qwen3:4b)\S+/);
  assert.match(await ollamaPullHint({ detect: async () => ({ memoryGB: 4 }) }), /hosted model will work better/);
  assert.doesNotMatch(await ollamaPullHint({ detect: async () => ({ memoryGB: 8 }) }), /Install\/start Ollama/);
});
