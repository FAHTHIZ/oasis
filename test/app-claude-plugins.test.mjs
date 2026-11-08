import test from 'node:test';
import assert from 'node:assert/strict';
import { searchMarketplace, marketplaceCount } from '../app/core/claude-plugins.mjs';

const overview = { marketplaces: [{ name: 'official', plugins: [
  { name: 'zeta-tool', description: 'Something else' },
  { name: 'code-review', description: 'Review pull requests', installed: true },
  { name: 'frontend-design', description: 'Distinctive UI design' },
  { name: 'reviewer-x', description: 'A review helper' }
] }] };

test('popular plugins come first when nothing is typed', () => {
  assert.deepEqual(searchMarketplace(overview).map((p) => p.name), ['frontend-design', 'code-review', 'reviewer-x', 'zeta-tool']);
  assert.equal(searchMarketplace(overview)[1].id, 'code-review@official');
  assert.equal(searchMarketplace(overview)[1].installed, true);
});

test('search matches every word in the name or description', () => {
  assert.deepEqual(searchMarketplace(overview, 'review').map((p) => p.name), ['code-review', 'reviewer-x']);
  assert.deepEqual(searchMarketplace(overview, 'ui design').map((p) => p.name), ['frontend-design']);
  assert.deepEqual(searchMarketplace(overview, 'nothing here'), []);
  assert.equal(searchMarketplace(overview, '', 2).length, 2);
  assert.equal(marketplaceCount(overview), 4);
  assert.deepEqual(searchMarketplace(null), []);
});
