import test from 'node:test';
import assert from 'node:assert/strict';
import { contextWindowSize, modelContextWindow } from '../src/context.mjs';

test('Claude models with a native 1M window get it; older ones stay at 200K and Haiku 5.5 stops at its 100K price tier', () => {
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-opus-4-8', 'claude-opus-4-7',
    'claude-opus-4-6', 'claude-sonnet-4-6', 'cc/claude-opus-4-6', 'claude-fable-5-1', 'claude-fable-5', 'claude-mythos-5']) {
    assert.equal(modelContextWindow(id), 1_000_000, id);
  }
  assert.equal(modelContextWindow('anthropic/claude-opus-4.6', { baseURL: 'https://api.anthropic.com' }), 1_000_000);
  // OpenRouter bills Opus 4.6 prompts over 200K at a higher rate, so the window stops there.
  assert.equal(modelContextWindow('anthropic/claude-opus-4.6', { baseURL: 'https://openrouter.ai/api/v1' }), 200_000);
  assert.equal(modelContextWindow('claude-haiku-5-5'), 100_000);
  for (const id of ['claude-sonnet-4-5-20250929', 'claude-sonnet-4-20250514', 'claude-opus-4-1-20250805', 'claude-haiku-4-5']) {
    assert.equal(modelContextWindow(id), 200_000, id);
  }
});

test('an explicit contextWindow still wins over the Claude default', () => {
  assert.equal(contextWindowSize({ model: 'claude-opus-5-5', contextWindow: 200000 }, {}), 200000);
  assert.equal(contextWindowSize({ model: 'claude-opus-5-5' }, { OASIS_CONTEXT_WINDOW: '300000' }), 300000);
});
