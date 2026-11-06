import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { nearMiss } from '../src/package-vetting.mjs';
import { splitTiers, interleave, SEEDS } from '../scripts/update-popular-packages.mjs';

const data = JSON.parse(readFileSync(new URL('../src/data/popular-packages.json', import.meta.url), 'utf8'));

test('the popularity snapshot covers thousands of names per registry, including every seeded direct-install name', () => {
  for (const [key, min] of [['npm', 3000], ['pypi', 3000], ['crates', 2000]]) {
    assert.ok(data[key].targets.length >= min, key + ': ' + data[key].targets.length);
    for (const seed of SEEDS[key]) assert.ok(data[key].targets.includes(seed), key + ' seed ' + seed);
  }
});

test('lookalikes of packages beyond the old hand-kept lists are caught; popular names are trusted as themselves', () => {
  // Ranked well past the ~130 names the guard used to know.
  const squats = [['npm', 'electorn', 'electron'], ['npm', 'tailwindcs', 'tailwindcss'], ['pypi', 'langchian', 'langchain'], ['pypi', 'pydanitc', 'pydantic'], ['pypi', 'python-dateutils', 'python-dateutil'], ['cargo', 'ripgrpe', 'ripgrep'], ['cargo', 'serde_jsno', 'serde_json']];
  for (const [registry, name, expected] of squats) assert.equal(nearMiss(registry, name), expected, registry + ' ' + name);
  for (const [registry, name] of [['npm', 'next'], ['npm', 'zod'], ['npm', 'tailwindcss'], ['npm', 'vite'], ['pypi', 'fastapi'], ['pypi', 'httpx'], ['cargo', 'tokio'], ['npm', 'esbuild-plugin-unrelated-thing']]) {
    assert.equal(nearMiss(registry, name), '', registry + ' ' + name);
  }
});

test('the generator interleaves rankings, puts seeds first and splits targets from known names', () => {
  assert.deepEqual(interleave(['a', 'b', 'c'], ['x']), ['a', 'x', 'b', 'c']);
  const ranked = Array.from({ length: 12000 }, (_, i) => 'pkg' + i);
  const tiers = splitTiers(ranked, ['seeded', 'pkg5']);
  assert.equal(tiers.targets[0], 'seeded');
  assert.equal(tiers.targets.length, 3000);
  assert.equal(tiers.known.length, 7000);
  assert.equal(tiers.targets.filter((name) => name === 'pkg5').length, 1);
});
