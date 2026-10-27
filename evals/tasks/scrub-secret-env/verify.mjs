import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
const source = { PATH: '/bin', NORMAL_SETTING: 'ok', OPENAI_API_KEY: 'secret', GH_TOKEN: 'secret', PRIVATE_KEY_PATH: '/secret', authORIZATION: 'secret' };
const result = m.scrubEnvironment(source);
assert.deepEqual(result, { PATH: '/bin', NORMAL_SETTING: 'ok' });
assert.equal(source.OPENAI_API_KEY, 'secret', 'input must not be mutated');
