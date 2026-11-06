import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, stat, utimes } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  findCatalogModel, catalogContextWindow, catalogPrice, providerForBaseURL, refreshModelCatalog,
  catalogRefreshDisabled, catalogCachePath, catalogImageInput, loadModelCatalog, trimCatalog, resetModelCatalogForTest
} from '../src/model-catalog.mjs';
import { contextWindowSize } from '../src/context.mjs';
import { priceFor } from '../src/pricing.mjs';
import { imageInputCapability } from '../src/images.mjs';

const RAW = {
  acme: { id: 'acme', api: 'https://api.acme.test/v1', models: {
    'acme-1': { limit: { context: 300000, output: 8000 }, cost: { input: 1, output: 2, cache_read: 0.1, tiers: [{ input: 2, output: 4, cache_read: 0.2, tier: { type: 'context', size: 128000 } }] } },
    'acme-flat': { limit: { context: 64000, input: 50000 }, cost: { input: 0.5, output: 1 } },
    'acme-eye': { limit: { context: 64000 }, modalities: { input: ['text', 'image'], output: ['text'] } },
    'acme-text': { limit: { context: 64000 }, modalities: { input: ['text'], output: ['text'] } }
  } },
  router: { id: 'router', api: 'https://router.test/api', models: { 'acme/acme-1': { limit: { context: 200000 }, cost: { input: 1.2, output: 2.4 } } } },
  b: { models: {} }, c: { models: {} }, d: { models: {} }
};

async function customCatalog(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-catalog-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'api.json');
  await writeFile(file, JSON.stringify(RAW));
  return { dir, env: { OASIS_MODEL_CATALOG: file, OASIS_CONFIG_DIR: dir } };
}

test('the bundled models.dev snapshot resolves current models across id spellings', () => {
  const env = {};
  assert.equal(findCatalogModel('claude-opus-5-5', { env }).provider, 'anthropic');
  assert.equal(findCatalogModel('claude-sonnet-4-5-20250929', { env }).id, 'claude-sonnet-4-5-20250929');
  // Router prefixes, Bedrock profile ids and dotted/dashed versions all reach a catalog entry.
  assert.ok(findCatalogModel('qwen3-coder', { env }));
  assert.equal(findCatalogModel('claude-sonnet-4-20250514', { env }).id, 'global.anthropic.claude-sonnet-4-20250514-v1:0');
  assert.equal(findCatalogModel('cc/claude-opus-4-6', { env }).id, 'claude-opus-4-6');
  assert.equal(findCatalogModel('definitely-not-a-model-xyz', { env }), null);
  assert.equal(contextWindowSize({ model: 'definitely-not-a-model-xyz' }, env), 32768);
});

test('a custom catalog file drives windows and prices; the baseURL picks the provider', async (t) => {
  const { env } = await customCatalog(t);
  assert.equal(providerForBaseURL('https://router.test/api/v1', env), 'router');
  assert.equal(providerForBaseURL('https://api.anthropic.com', env), 'anthropic');
  assert.equal(findCatalogModel('acme/acme-1', { env }).provider, 'router');
  assert.equal(findCatalogModel('acme-1', { env, baseURL: 'https://api.acme.test/v1' }).provider, 'acme');
  assert.equal(findCatalogModel('acme-1', { env, baseURL: 'https://router.test/api' }).id, 'acme/acme-1');
  // A higher-priced context tier caps the working window; an input limit does too.
  assert.equal(catalogContextWindow('acme-1', { env }), 128000);
  assert.equal(catalogContextWindow('acme-flat', { env }), 50000);
  assert.equal(contextWindowSize({ model: 'acme-1', contextWindow: 300000 }, env), 300000);
  assert.deepEqual(catalogPrice('acme-1', { env }), { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, long: { threshold: 128000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0 } });
  assert.equal(priceFor('acme-1', { env, config: { baseURL: 'https://router.test/api' } }).input, 1.2);
  // Settings overrides and local servers still win over the catalog.
  assert.equal(priceFor('acme-1', { env, overrides: { 'acme-1': { input: 9, output: 9 } } }).input, 9);
  assert.equal(priceFor('acme-1', { env, config: { protocol: 'ollama', baseURL: 'http://127.0.0.1:11434' } }).local, true);
});

test('image support comes from the catalog modalities, with overrides and a fallback for unlisted models', async (t) => {
  const { env } = await customCatalog(t);
  assert.equal(catalogImageInput('acme-eye', { env }), true);
  assert.equal(catalogImageInput('acme-text', { env }), false);
  assert.equal(catalogImageInput('acme-1', { env }), null);
  assert.equal(imageInputCapability({ model: 'acme-eye' }, env).status, 'supported');
  assert.equal(imageInputCapability({ model: 'acme-text' }, env).status, 'unsupported');
  assert.equal(imageInputCapability({ model: 'acme-text' }, { ...env, OASIS_MODEL_VISION: '1' }).status, 'supported');
  assert.equal(imageInputCapability({ model: 'acme-eye' }, { ...env, OASIS_MODEL_VISION: '0' }).status, 'unsupported');
  assert.equal(imageInputCapability({ model: 'llava:13b' }, env).status, 'supported');
  assert.equal(imageInputCapability({ model: 'acme-1' }, env).status, 'unknown');
  // The bundled snapshot knows text-only models the old name patterns could not classify.
  assert.equal(imageInputCapability({ model: 'deepseek-chat' }, {}).status, 'unsupported');
  assert.equal(imageInputCapability({ model: 'claude-opus-4-6' }, {}).status, 'supported');
});

test('trimCatalog keeps only limits and prices', () => {
  const trimmed = trimCatalog({ ...RAW, acme: { ...RAW.acme, models: { ...RAW.acme.models, junk: { name: 'x' } } } }, ['acme']);
  assert.deepEqual(Object.keys(trimmed), ['acme']);
  assert.equal(trimmed.acme.models.junk, undefined);
  assert.deepEqual(trimmed.acme.models['acme-eye'], { context: 64000, image: true });
  assert.deepEqual(trimmed.acme.models['acme-1'], { context: 300000, output: 8000, cost: { input: 1, output: 2, cache_read: 0.1, tiers: [{ input: 2, output: 4, cache_read: 0.2, size: 128000 }] } });
});

test('refresh downloads models.dev into the user cache once a day and the newer cache wins', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-catalog-cache-'));
  t.after(() => { rm(dir, { recursive: true, force: true }); resetModelCatalogForTest(); });
  const env = { OASIS_CONFIG_DIR: dir };
  let calls = 0;
  const fetchImpl = async (url) => { calls += 1; assert.equal(url, 'https://models.dev/api.json'); return new Response(JSON.stringify(RAW)); };
  assert.equal(await refreshModelCatalog({ env, fetchImpl, now: Date.now() + 365 * 864e5 }), true);
  const cached = JSON.parse(await readFile(catalogCachePath(env), 'utf8'));
  assert.equal(cached.source, 'https://models.dev/api.json');
  assert.ok(cached.providers.acme);
  assert.equal(loadModelCatalog(env).providers.acme.api, 'https://api.acme.test/v1');
  assert.equal(await refreshModelCatalog({ env, fetchImpl }), false, 'fresh cache is reused');
  assert.equal(calls, 1);
  const old = new Date(Date.now() - 2 * 864e5);
  await utimes(catalogCachePath(env), old, old);
  assert.equal(await refreshModelCatalog({ env, fetchImpl: async () => new Response('nope', { status: 503 }) }), false);
  assert.equal(await refreshModelCatalog({ env, fetchImpl: async () => { throw new Error('offline'); } }), false);
  assert.ok((await stat(catalogCachePath(env))).size > 0, 'failed refresh keeps the old cache');
});

test('catalog refresh honors opt-outs', () => {
  assert.equal(catalogRefreshDisabled({}), false);
  assert.equal(catalogRefreshDisabled({ OASIS_MODEL_CATALOG_REFRESH: '0' }), true);
  assert.equal(catalogRefreshDisabled({ DISABLE_NONESSENTIAL_TRAFFIC: '1' }), true);
  assert.equal(catalogRefreshDisabled({ CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' }), true);
  assert.equal(catalogRefreshDisabled({ NODE_TEST_CONTEXT: 'child-v8' }), true);
  assert.equal(catalogRefreshDisabled({ CI: 'true' }), true);
  assert.equal(catalogRefreshDisabled({ CI: 'false' }), false);
});
