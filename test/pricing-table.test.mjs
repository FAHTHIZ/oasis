import test from 'node:test';
import assert from 'node:assert/strict';
import { priceFor, estimateCostUsd } from '../src/pricing.mjs';

const env = {};
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' != ' + b);

test('current Claude list prices (platform.claude.com pricing, 2026-11)', () => {
  assert.deepEqual([priceFor('claude-opus-5-5', { env }).input, priceFor('claude-opus-5-5', { env }).output, priceFor('claude-opus-5-5', { env }).cacheRead], [4, 20, 0.2]);
  assert.equal(priceFor('us.anthropic.claude-opus-5-5', { env }).input, 4);
  assert.equal(priceFor('claude-opus-5', { env }).input, 5);
  assert.equal(priceFor('claude-sonnet-5', { env }).input, 2);
  assert.equal(priceFor('claude-sonnet-5-5', { env }).cacheRead, 0.1);
  assert.equal(priceFor('claude-sonnet-4-5-20250929', { env }).input, 3);
  assert.equal(priceFor('claude-haiku-5-5', { env }).input, 0.1);
  assert.equal(priceFor('claude-haiku-4-5', { env }).input, 1);
  assert.equal(priceFor('claude-fable-5-1', { env }).output, 50);
});

test('long prompts are billed at the long-context tier for the whole request', () => {
  near(estimateCostUsd('claude-haiku-5-5', { inputTokens: 50000, outputTokens: 1000 }, { env }), (50000 * 0.1 + 1000 * 0.5) / 1e6);
  near(estimateCostUsd('claude-haiku-5-5', { inputTokens: 150000, outputTokens: 1000 }, { env }), (150000 * 0.5 + 1000 * 2.5) / 1e6);
  // Cache hits count toward the prompt length and use the tier's cache price.
  near(estimateCostUsd('claude-haiku-5-5', { inputTokens: 150000, cacheReadTokens: 140000, outputTokens: 0 }, { env }), (10000 * 0.5 + 140000 * 0.05) / 1e6);
  near(estimateCostUsd('gpt-5.5', { inputTokens: 300000, outputTokens: 1000 }, { env }), (300000 * 10 + 1000 * 45) / 1e6);
});

test('current OpenAI list prices (developers.openai.com pricing, 2026-11)', () => {
  assert.equal(priceFor('gpt-5.6-sol', { env }).input, 4);
  assert.equal(priceFor('gpt-5.6-luna', { env }).output, 1.2);
  assert.equal(priceFor('gpt-6.1-sol', { env }).cacheRead, 0.1);
  assert.equal(priceFor('gpt-6-astra', { env }).input, 10);
  assert.equal(priceFor('openai/gpt-6-sol', { env }).input, 2);
  assert.equal(priceFor('gpt-5.5', { env }).output, 30);
  assert.equal(priceFor('gpt-5', { env }).input, 1.25);
});

test('Gemini 3, DeepSeek V4, Kimi K3, GLM-5, MiniMax M3 and Grok 4.7 use published prices', async () => {
  const { estimateCostUsd } = await import('../src/pricing.mjs');
  const per = (model, inputTokens, outputTokens = 0) => estimateCostUsd(model, { inputTokens, outputTokens });
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' != ' + b);
  near(per('gemini-3.1-pro-preview', 1e6 / 10, 1e6 / 10), 0.2 + 1.2);
  near(per('gemini-3.1-pro-preview', 300_000), 1.2);
  near(per('gemini-3.8-flash', 1e6), 0.75);
  near(per('gemini-3-flash-preview', 1e6), 0.5);
  near(per('gemini-3.1-flash-lite', 1e6), 0.25);
  near(per('gemini-2.5-flash-lite', 1e6), 0.1);
  near(per('deepseek-v4-pro', 1e6), 1.32);
  near(per('deepseek-flash', 0, 1e6), 1.2);
  near(per('kimi-k3', 1e6, 1e6), 18);
  near(per('z-ai/glm-5', 1e6), 1);
  near(per('MiniMax-M3', 600_000), 0.36);
  near(per('grok-4.7', 100_000, 100_000), 0.2 + 0.6);
  near(per('grok-4.7', 250_000), 1);
});
