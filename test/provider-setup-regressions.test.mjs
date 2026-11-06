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

