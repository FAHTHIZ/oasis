import test from 'node:test';
import assert from 'node:assert/strict';
import { describeConfig } from '../src/logger.mjs';

test('describes the endpoint and retries', () => {
  const text = describeConfig({ endpoint: 'https://x.test', apiKey: 'k', retries: 2 });
  assert.match(text, /https:\/\/x\.test/);
  assert.match(text, /"retries":2/);
});
