import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.equal(m.sliceLines('a\nb\nc'), 'a\nb\nc');
assert.equal(m.sliceLines('a\r\nb\r\nc', 2, 1), 'b');
assert.equal(m.sliceLines('a\nb\nc', 0, 2), 'a\nb');
assert.equal(m.sliceLines('a\nb', 99, 5), '');
