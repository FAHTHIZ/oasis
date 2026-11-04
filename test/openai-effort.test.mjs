import test from 'node:test';
import assert from 'node:assert/strict';
import { openaiEffortFor, applyEffort, reasoningEffortFor } from '../src/agent.mjs';
import { modelContextWindow } from '../src/context.mjs';
import { estimateCostUsd } from '../src/pricing.mjs';

test('effort values are clamped to what each OpenAI model accepts', () => {
  assert.equal(openaiEffortFor('gpt-6.1-sol', 'max'), 'max');
  assert.equal(openaiEffortFor('gpt-5.6-sol', 'max'), 'max');
  assert.equal(openaiEffortFor('gpt-5.5', 'max'), 'xhigh');
  assert.equal(openaiEffortFor('gpt-5.1', 'xhigh'), 'high');
  assert.equal(openaiEffortFor('gpt-6-astra', 'none'), 'low');
  assert.equal(openaiEffortFor('gpt-6.1-sol', 'minimal'), 'low');
  assert.equal(openaiEffortFor('gpt-5.6-sol', 'none'), 'none');
  assert.equal(openaiEffortFor('some-local-model', 'max'), 'max');
  assert.equal(openaiEffortFor('gpt-6.1-sol', ''), '');
});

test('/effort max asks for the deepest effort the model supports', () => {
  assert.equal(applyEffort({ model: 'gpt-6.1-sol' }, 'max').reasoningEffort, 'max');
  assert.equal(applyEffort({ model: 'gpt-5.5' }, 'max').reasoningEffort, 'xhigh');
  assert.equal(applyEffort({ model: 'o3' }, 'max').reasoningEffort, 'high');
  assert.equal(applyEffort({ model: 'gpt-6.1-sol' }, 'high').reasoningEffort, 'high');
});

test('GPT-6 models get reasoning effort and a real context window', () => {
  assert.equal(reasoningEffortFor('ultrathink about this', { model: 'gpt-6.1-sol' }, {}), 'high');
  assert.equal(reasoningEffortFor('hi', { model: 'gpt-6.1-sol', reasoningEffort: 'max' }, {}), 'max');
  assert.equal(reasoningEffortFor('hi', { model: 'gpt-6-astra', reasoningEffort: 'none' }, {}), 'low');
  assert.equal(modelContextWindow('gpt-6.1-sol'), 400_000);
});

test('GPT-6.1 Sol and Astra bill long prompts at the long-context rate', () => {
  const short = estimateCostUsd('gpt-6.1-sol', { inputTokens: 100_000, outputTokens: 1000 });
  const long = estimateCostUsd('gpt-6.1-sol', { inputTokens: 300_000, outputTokens: 1000 });
  assert.ok(Math.abs(short - (0.2 + 0.01)) < 1e-9, String(short));
  assert.ok(Math.abs(long - (1.2 + 0.015)) < 1e-9, String(long));
  const astra = estimateCostUsd('gpt-6-astra', { inputTokens: 300_000, outputTokens: 1000 });
  assert.ok(Math.abs(astra - (6 + 0.075)) < 1e-9, String(astra));
});
