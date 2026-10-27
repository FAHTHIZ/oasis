import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.equal(m.isSafeTaskId('config-change-2'), true);
assert.equal(m.isSafeTaskId('a'), true);
for (const value of ['', '../secret', 'UPPER', 'has space', 'a/b', '.hidden', 'x'.repeat(65), null]) assert.equal(m.isSafeTaskId(value), false);
