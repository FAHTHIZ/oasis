import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.deepEqual(m.dedupeNames(['read_file', 'edit_file', 'read_file', 'glob_files', 'edit_file']), ['read_file', 'edit_file', 'glob_files']);
assert.deepEqual(m.dedupeNames([]), []);
