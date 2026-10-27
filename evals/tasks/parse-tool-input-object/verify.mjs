import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.deepEqual(m.parseToolInput('{"x":1}'), { x: 1 });
assert.deepEqual(m.parseToolInput({ ok: true }), { ok: true });
for (const input of ['bad json', 'null', '3', '"text"', '[1,2]', null, 3, [], undefined]) assert.deepEqual(m.parseToolInput(input), {});
