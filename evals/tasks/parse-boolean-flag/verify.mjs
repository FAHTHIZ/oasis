import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.equal(m.parseBooleanFlag(true), true);
for (const value of ['1', 'true', ' YES ', 'On', 3]) assert.equal(m.parseBooleanFlag(value), true);
for (const value of [false, 0, '', 'false', '0', 'no', 'OFF', null, undefined, {}]) assert.equal(m.parseBooleanFlag(value), false);
