import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
// A closed port: a goal that is wrongly accepted fails on the network, not silently.
const env = { ...process.env, OASIS_PROTOCOL: 'openai-compatible', OASIS_BASE_URL: 'http://127.0.0.1:9/v1', OASIS_MODEL: 'x', OASIS_NO_UPDATE_CHECK: '1', OASIS_API_KEY: 'k' };

test('a headless goal over 4,000 characters is refused, not silently cut', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-goal-len-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const long = 'all of these pass: ' + 'x'.repeat(4100);
  for (const args of [['-p', '--goal', long], ['-p', '/goal ' + long]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, env: { ...env, HOME: root }, encoding: 'utf8', timeout: 30000, input: '' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /A goal can be at most 4,000 characters/);
  }
});
