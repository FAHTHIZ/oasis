import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.equal(m.resolveRelative('/tmp/work', 'src/lib.mjs'), '/tmp/work/src/lib.mjs');
assert.equal(m.resolveRelative('/tmp/work', '.'), '/tmp/work');
assert.throws(() => m.resolveRelative('/tmp/work', '../secret'), /escapes/);
assert.throws(() => m.resolveRelative('/tmp/work', '/etc/passwd'), /escapes/);
