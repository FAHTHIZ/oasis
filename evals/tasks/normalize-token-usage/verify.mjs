import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
assert.deepEqual(m.normalizeUsage({ input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 4 }), { inputTokens: 16, outputTokens: 3, totalTokens: 19 });
assert.deepEqual(m.normalizeUsage({ prompt_tokens: 7, completion_tokens: 2 }), { inputTokens: 7, outputTokens: 2, totalTokens: 9 });
assert.deepEqual(m.normalizeUsage({}), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
