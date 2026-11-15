import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProtocol } from '../src/config.mjs';

test('OASIS_PROTOCOL=openai means chat completions instead of failing', () => {
  assert.equal(validateProtocol('openai'), 'openai-compatible');
  assert.equal(validateProtocol(' OpenAI '), 'openai-compatible');
  assert.equal(validateProtocol('openai-responses'), 'openai-responses');
});

test('an unknown protocol error names the value it got', () => {
  assert.throws(() => validateProtocol('gemini'), /openai-compatible \(or openai\).*got "gemini"/);
});
