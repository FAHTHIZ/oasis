import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelAlias } from '../src/model-aliases.mjs';

test('sonnet and haiku aliases use the 5.5 models on every cloud', () => {
  const env = {};
  assert.equal(resolveModelAlias('sonnet', { protocol: 'bedrock', env }), 'us.anthropic.claude-sonnet-5-5');
  assert.equal(resolveModelAlias('haiku', { protocol: 'bedrock', env }), 'us.anthropic.claude-haiku-5-5');
  assert.equal(resolveModelAlias('sonnet', { protocol: 'vertex', env }), 'claude-sonnet-5-5');
  assert.equal(resolveModelAlias('haiku', { protocol: 'vertex', env }), 'claude-haiku-5-5');
  assert.equal(resolveModelAlias('sonnet', { protocol: 'foundry', env }), 'claude-sonnet-5-5');
  assert.equal(resolveModelAlias('sonnet', { protocol: 'bedrock', env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'pinned' } }), 'pinned');
});
