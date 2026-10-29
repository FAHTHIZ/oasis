import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { normalizeHeaderValue } = await import(pathToFileURL(path.join(root, 'src/lib.mjs')).href);
assert.equal(normalizeHeaderValue({ ACCEPT: ' application/json ' }, 'accept'), 'application/json');
assert.equal(normalizeHeaderValue(new Headers({ 'X-Trace': ' trace-1 ' }), 'x-trace'), 'trace-1');
assert.equal(normalizeHeaderValue({}, 'missing'), null);
assert.throws(() => normalizeHeaderValue({ TOKEN: 'a', token: 'b' }, 'token'), /ambiguous/i);
