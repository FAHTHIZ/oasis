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
