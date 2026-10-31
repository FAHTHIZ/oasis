import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveConfig } from '../src/config.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

test('`oasis exec PROMPT` runs headless like `oasis -p PROMPT`', async (t) => {
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-exec-cfg-'));
  t.after(() => rm(config, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: config };
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'm', apiKey: 'x' }, { env });
  const run = spawnSync(process.execPath, [cli, 'exec', 'hello', '--output-format', 'json'], { cwd: config, env, input: '', encoding: 'utf8', timeout: 60000 });
  const line = run.stdout.trim().split('\n').pop();
  const result = JSON.parse(line);
  assert.equal(result.type, 'result');
  assert.equal(result.is_error, true);
  assert.match(result.result, /model provider/);
});
