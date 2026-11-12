import test from 'node:test';
import assert from 'node:assert/strict';
test('a cloud model behind a localhost gateway is priced; local servers stay free', async () => {
  const { priceFor: price, cloudModelBehindGateway } = await import('../src/pricing.mjs');
  const gateway = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:4000/v1' };
  assert.equal(cloudModelBehindGateway('gemini-flash-lite-latest', gateway), true);
  assert.ok(price('gemini-flash-lite-latest', { config: gateway }).input > 0);
  assert.ok(price('anthropic/claude-sonnet-4-5', { config: gateway }).input > 0);
  assert.equal(price('qwen2.5-coder:7b', { config: gateway }).local, true);
  assert.equal(price('gemma-4-31b-it', { config: gateway }).local, true);
  assert.equal(price('gemini-flash-lite-latest', { config: { protocol: 'openai-compatible', baseURL: 'http://localhost:1234/v1' } }).local, true);
  assert.equal(price('gpt-5', { config: { protocol: 'ollama', baseURL: 'http://localhost:11434' } }).local, true);
});

test('a remote keyless endpoint with no credentials is free; one with credentials or on loopback is not', async () => {
  const { priceFor: price, estimateCostUsd } = await import('../src/pricing.mjs');
  const free = { protocol: 'openai-compatible', baseURL: 'https://text.pollinations.ai/openai', keyless: true };
  assert.equal(price('openai-fast', { config: free, env: {} }).keyless, true);
  assert.equal(price('gpt-oss-20b', { config: free, env: {} }).keyless, true);
  assert.equal(estimateCostUsd('openai-fast', { inputTokens: 50_000, outputTokens: 2_000 }, { config: free, env: {} }), 0);
  assert.equal(price('openai-fast', { config: { ...free, apiKey: 'sk-x' }, env: {} }), null);
  assert.equal(price('openai-fast', { config: { ...free, customHeaders: { Authorization: 'Bearer x' } }, env: {} }), null);
  // A keyless gateway on loopback holds the user's own cloud keys: still priced.
  assert.ok(price('gemini-flash-lite-latest', { config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:4000/v1', keyless: true }, env: {} }).input > 0);
});
