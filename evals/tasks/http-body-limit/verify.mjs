import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { parseJsonBody } = await import(pathToFileURL(path.join(root, 'src/lib.mjs')).href);
assert.deepEqual(parseJsonBody(['{"a":', '1}']), { statusCode: 200, body: { a: 1 } });
assert.equal(parseJsonBody(['{"x":"é"}'], 9).statusCode, 413, 'UTF-8 bytes, not code points');
assert.equal(parseJsonBody(['{"x":}']).statusCode, 400);
assert.equal(parseJsonBody(['x'.repeat(16385)], 'invalid').statusCode, 413);
