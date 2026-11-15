import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'oasis.mjs');

function run(home, extraEnv = {}) {
  const env = { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, '.config'), APPDATA: path.join(home, 'AppData'), ...extraEnv };
  for (const key of Object.keys(env)) if (/^(OASIS_|OPENAI_|ANTHROPIC_|GEMINI_|OPENROUTER_)/.test(key) && !(key in extraEnv)) delete env[key];
  return spawnSync(process.execPath, [CLI, 'config'], { env, encoding: 'utf8', timeout: 20000 });
}

// Found as a new user: before setup, `oasis config` printed the built-in
// default (an OpenAI URL and model) as if it had been chosen, while
// `oasis doctor` said the provider was "not set yet".
test('oasis config before setup says no provider is set instead of printing defaults', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-cmd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = run(home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not set yet/);
  assert.doesNotMatch(result.stdout, /Base URL:/);
  assert.doesNotMatch(result.stdout, /api\.openai\.com/);
});

test('oasis config shows the provider once one is configured', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-cmd-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const result = run(home, { OASIS_BASE_URL: 'http://127.0.0.1:11434/v1', OASIS_MODEL: 'qwen3' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Base URL: http:\/\/127\.0\.0\.1:11434\/v1/);
  assert.match(result.stdout, /Model: qwen3/);
});
