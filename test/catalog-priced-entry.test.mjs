import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { catalogPrice, providerForBaseURL, resetModelCatalogForTest } from '../src/model-catalog.mjs';

// Seen with a newer models.dev download: a desktop app listed its API on
// 127.0.0.1, so every localhost gateway was taken for that app, and a reseller
// listing "anthropic/claude-sonnet-4-5" without prices hid Anthropic's own.
test('a localhost gateway is not mistaken for a catalog app, and unpriced listings do not hide prices', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-catalog-'));
  t.after(async () => { resetModelCatalogForTest(); await rm(dir, { recursive: true, force: true }); });
  const file = path.join(dir, 'catalog.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 9, fetchedAt: '2026-11-01T00:00:00Z', providers: {
    'desktop-app': { api: 'http://127.0.0.1:1337/v1', models: { 'claude-sonnet-4-5': { context: 1000 } } },
    reseller: { api: 'https://reseller.example/v1', models: { 'anthropic/claude-sonnet-4-5': { context: 200000 } } },
    anthropic: { api: 'https://api.anthropic.com/v1', models: { 'claude-sonnet-4-5': { context: 200000, cost: { input: 3, output: 15 } } } }
  } }));
  const env = { OASIS_MODEL_CATALOG: file };
  resetModelCatalogForTest();
  assert.equal(providerForBaseURL('http://127.0.0.1:4000/v1', env), null);
  assert.equal(providerForBaseURL('http://localhost:4000/v1', env), null);
  assert.equal(catalogPrice('anthropic/claude-sonnet-4-5', { baseURL: 'http://127.0.0.1:4000/v1', env }).input, 3);
  assert.equal(catalogPrice('claude-sonnet-4-5', { baseURL: 'https://reseller.example/v1', env }).output, 15);
});
