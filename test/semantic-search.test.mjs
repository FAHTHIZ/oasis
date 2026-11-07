import test from 'node:test';
import assert from 'node:assert/strict';
import { cosineSimilarity, buildSemanticIndex, searchSemantic, formatSemanticSearch, SEMANTIC_SEARCH_TOOL_DEFINITION } from '../src/semantic-search.mjs';

const mockFetch = () => async (url, init) => {
  const body = JSON.parse(init.body);
  const hash = (s) => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 1000; return h / 1000; };
  const vector = [hash(body.prompt), hash(body.prompt + 'a'), hash(body.prompt + 'b'), hash(body.prompt + 'c')];
  return { ok: true, json: async () => ({ embedding: vector }) };
};

const files = [
  { path: 'src/a.js', mtime: 1 },
  { path: 'src/b.js', mtime: 2 }
];

import { mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';

async function makeTempRoot() {
  const root = await os.tmpdir() + '/oasis-semantic-test-' + Date.now();
  await mkdir(root + '/src', { recursive: true });
  await writeFile(root + '/src/a.js', 'export function alpha() {}');
  await writeFile(root + '/src/b.js', 'export function beta() {}');
  return root;
}

test('cosine similarity basics', () => {
  assert.equal(cosineSimilarity([1, 0], [1, 0]), 1);
  assert.equal(cosineSimilarity([1, 0], [0, 1]), 0);
  assert.equal(cosineSimilarity([], []), 0);
});

test('buildSemanticIndex caches vectors', async () => {
  const root = await makeTempRoot();
  const state = await buildSemanticIndex(root, files, { fetchImpl: mockFetch(), env: { OASIS_CONFIG_DIR: root + '/.oasis' } });
  assert.equal(Object.keys(state.entries).length, 2);
  await rm(root, { recursive: true, force: true });
});

test('searchSemantic ranks and fuses scores', async () => {
  const root = await makeTempRoot();
  await buildSemanticIndex(root, files, { fetchImpl: mockFetch(), env: { OASIS_CONFIG_DIR: root + '/.oasis' } });
  const result = await searchSemantic(root, 'alpha function', { fetchImpl: mockFetch(), env: { OASIS_CONFIG_DIR: root + '/.oasis' }, lexicalResults: [{ path: 'src/a.js', score: 1 }], repoMapRank: new Map([['src/a.js', 0.8]]) });
  assert.ok(result.results.length > 0);
  assert.ok(result.results[0].fusedScore !== undefined);
  await rm(root, { recursive: true, force: true });
});

test('tool definition is well-formed', () => {
  assert.equal(SEMANTIC_SEARCH_TOOL_DEFINITION.function.name, 'semantic_search');
  assert.ok(SEMANTIC_SEARCH_TOOL_DEFINITION.function.parameters.required.includes('query'));
});

test('formatSemanticSearch handles empty results', () => {
  const output = formatSemanticSearch({ query: 'nothing', results: [], indexedFiles: 0 });
  assert.ok(output.includes('No semantic matches'));
});
