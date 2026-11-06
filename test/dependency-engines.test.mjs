import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import subset from 'semver/ranges/subset.js';
import { MIN_NODE_VERSION, isNodeVersionSupported } from '../src/config.mjs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));

test('package.json engines and MIN_NODE_VERSION name the same floor', () => {
  assert.equal(pkg.engines.node, '>=' + MIN_NODE_VERSION.replace(/\.0$/, ''));
  assert.equal(isNodeVersionSupported(MIN_NODE_VERSION), true);
});

// A dependency update that raises the Node.js floor (unpdf 2 needs Node 24)
// would make "npm install" warn, or fail with engine-strict, on Node versions
// OASIS still claims to support. Optional platform packages are exempt: npm
// skips them where they do not apply.
test('every installed runtime dependency supports the declared Node.js floor', () => {
  const offenders = [];
  for (const [location, entry] of Object.entries(lock.packages)) {
    if (!location || entry.dev || entry.optional || entry.devOptional) continue;
    const range = entry.engines && entry.engines.node;
    if (range && !subset(pkg.engines.node, range)) offenders.push(location.replace(/^.*node_modules\//, '') + '@' + entry.version + ' needs node ' + range);
  }
  assert.deepEqual(offenders, [], 'raise engines.node and MIN_NODE_VERSION together, or hold the dependency back');
});
