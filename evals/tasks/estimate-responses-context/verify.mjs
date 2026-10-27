import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.equal(m.estimateTokens({ role: 'user', content: 'abcdefgh' }), 2);
assert.ok(m.estimateTokens({ role: 'assistant', content: null, responseItems: [{ type: 'reasoning', text: 'x'.repeat(4000) }] }) > 1000);
assert.ok(m.estimateTokens({ content: [{ type: 'text', text: 'x'.repeat(40) }] }) >= 10);
