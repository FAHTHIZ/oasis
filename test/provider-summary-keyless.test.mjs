import test from 'node:test';
import assert from 'node:assert/strict';
import { getProviderSummary } from '../src/config.mjs';

test('a saved keyless endpoint does not read as "not configured"', () => {
  const base = { protocol: 'openai-compatible', baseURL: 'https://text.example.ai/openai', model: 'm', configPath: '/x' };
  assert.equal(getProviderSummary({ ...base, keyless: true }).authentication, 'none needed; this endpoint works without a key');
  assert.equal(getProviderSummary(base).authentication, 'not configured');
  assert.equal(getProviderSummary({ ...base, apiKey: 'k' }).authentication, 'API key configured');
});
