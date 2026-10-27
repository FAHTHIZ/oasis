import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.deepEqual(m.normalizeReadRange(undefined, undefined), { offset: 1, limit: 2000 });
assert.deepEqual(m.normalizeReadRange('3', '12'), { offset: 3, limit: 12 });
assert.deepEqual(m.normalizeReadRange(0, -1), { offset: 1, limit: 1 });
assert.deepEqual(m.normalizeReadRange(8, 50000), { offset: 8, limit: 2000 });
