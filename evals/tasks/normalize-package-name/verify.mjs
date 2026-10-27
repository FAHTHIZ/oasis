import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.equal(m.normalizePackageName('prettier'), 'prettier');
assert.equal(m.normalizePackageName('@org/tool@1.2.0'), '@org/tool@1.2.0');
for (const value of ['', '../secret', 'foo;rm -rf /', 'https://example.test/a.tgz', 'hello world']) assert.throws(() => m.normalizePackageName(value), /package identifier/);
