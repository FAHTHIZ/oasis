import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { resolveRedirectTarget } = await import(pathToFileURL(path.join(root, 'src/lib.mjs')).href);
assert.equal(resolveRedirectTarget('https://api.example/v1/items', '../health'), 'https://api.example/health');
assert.equal(resolveRedirectTarget('http://api.example/x', 'http://api.example/y'), 'http://api.example/y');
for (const target of ['https://elsewhere.example/', 'javascript:alert(1)', 'https://u:p@api.example/x', '//elsewhere.example/x']) {
  assert.equal(resolveRedirectTarget('https://api.example/start', target), null, 'rejected ' + target);
}
