import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { executeTool } from '../src/tools.mjs';
import { shouldPromptForProviderBaseURL, validateBaseUrl } from '../src/config.mjs';

async function temporaryDirectory() {
  return await mkdtemp(path.join(os.tmpdir(), 'oasis-provider-setup-'));
}

function cleanProviderEnv(root) {
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(root, 'config') };
  for (const key of ['OASIS_BASE_URL', 'OASIS_PROTOCOL', 'OASIS_MODEL', 'OASIS_LOCAL_API_KEY']) delete env[key];
  return env;
}

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

