import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const workspace = process.argv[2];
import { spawnSync } from 'node:child_process';
for (const args of [['scripts/check-site.mjs'], ['--test']]) {
  const checked = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8', timeout: 120000 });
  if (checked.error || checked.status !== 0) throw new Error('Existing repository checks failed: ' + String(checked.error || checked.status) + '\n' + String(checked.stdout || '').slice(-4000) + String(checked.stderr || '').slice(-4000));
}
const m = await import(pathToFileURL(path.join(workspace, 'src', 'lib.mjs')).href);
const source = { PATH: '/bin', NORMAL_SETTING: 'ok', OPENAI_API_KEY: 'secret', GH_TOKEN: 'secret', PRIVATE_KEY_PATH: '/secret', authORIZATION: 'secret' };
const result = m.scrubEnvironment(source);
assert.deepEqual(result, { PATH: '/bin', NORMAL_SETTING: 'ok' });
assert.equal(source.OPENAI_API_KEY, 'secret', 'input must not be mutated');
