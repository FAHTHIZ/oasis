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
assert.deepEqual(m.normalizeUsage({ input_tokens: 10, output_tokens: 3, cache_creation_input_tokens: 2, cache_read_input_tokens: 4 }), { inputTokens: 16, outputTokens: 3, totalTokens: 19 });
assert.deepEqual(m.normalizeUsage({ prompt_tokens: 7, completion_tokens: 2 }), { inputTokens: 7, outputTokens: 2, totalTokens: 9 });
assert.deepEqual(m.normalizeUsage({}), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
