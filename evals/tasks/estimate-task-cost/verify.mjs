import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.equal(m.estimateCost(1000, 500, 2.5, 10), 0.0075);
assert.equal(m.estimateCost(18, 5, 1, 2), 0.000028);
assert.equal(m.estimateCost(10, 5, null, 2), null);
assert.equal(m.estimateCost(10, 5, -1, 2), null);
