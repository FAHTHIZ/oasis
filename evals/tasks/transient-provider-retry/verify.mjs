import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { shouldRetryStatus } = await import(pathToFileURL(path.join(root, 'src/lib.mjs')).href);
for (const status of [408, 425, 429, 500, 502, 503, 504]) {
  assert.equal(shouldRetryStatus(status, 1, 2), true, 'transient status ' + status);
  assert.equal(shouldRetryStatus(status, 2, 2), false, 'final allowed attempt');
}
for (const status of [200, 400, 401, 403, 404, 501]) assert.equal(shouldRetryStatus(status, 1, 3), false);
assert.equal(shouldRetryStatus(503, 0, 3), false);
assert.equal(shouldRetryStatus('503', 1, 3), false);
