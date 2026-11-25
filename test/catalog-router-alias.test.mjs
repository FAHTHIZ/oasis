// Regression: OASIS Route's \`auto\` alias matched OpenRouter's \`openrouter/auto\`
// catalog entry (2M context), so a session on a 32K model behind Route never
// compacted and the models table showed a 2M window.
import test from 'node:test';
import assert from 'node:assert/strict';
import { findCatalogModel, catalogContextWindow } from '../src/model-catalog.mjs';
import { contextWindowSize } from '../src/context.mjs';

test('a gateway auto alias does not borrow the OpenRouter auto router window', () => {
  for (const baseURL of ['http://127.0.0.1:8081/v1', 'http://127.0.0.1:20128/v1', 'http://localhost:4000/v1', 'https://route.example.com/v1']) {
    assert.equal(findCatalogModel('auto', { baseURL }), null, baseURL);
    assert.equal(catalogContextWindow('auto', { baseURL }), null, baseURL);
  }
  // Same conservative default as any model the catalog does not know.
  assert.equal(contextWindowSize({ model: 'auto', baseURL: 'http://127.0.0.1:8081/v1' }, {}), contextWindowSize({ model: 'unknown-model-x', baseURL: 'http://127.0.0.1:8081/v1' }, {}));
  assert.ok(contextWindowSize({ model: 'auto', baseURL: 'http://127.0.0.1:8081/v1' }, {}) < 2_000_000);
});

test('OpenRouter auto keeps its own catalog entry', () => {
  const entry = findCatalogModel('auto', { baseURL: 'https://openrouter.ai/api/v1' });
  if (entry) assert.equal(entry.provider, 'openrouter');
  assert.ok(findCatalogModel('gpt-4o', { baseURL: 'http://127.0.0.1:8081/v1' }), 'real model ids still resolve behind a gateway');
});
