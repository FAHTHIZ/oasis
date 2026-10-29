import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.argv[2];
const { normalizeArchivePath } = await import(pathToFileURL(path.join(root, 'src/lib.mjs')).href);
assert.equal(normalizeArchivePath('folder\\nested\\file.txt'), 'folder/nested/file.txt');
assert.equal(normalizeArchivePath('folder/./file.txt'), 'folder/file.txt');
for (const value of ['../escape', 'folder/../../escape', '/absolute', 'D:\\data\\x', '\\\\host\\share', 'file\0name', '.', '']) {
  assert.throws(() => normalizeArchivePath(value), (error) => Boolean(error), 'reject ' + JSON.stringify(value));
}
