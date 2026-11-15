import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const cli = path.resolve('src/oasis.mjs');

function run(env) {
  const home = mkdtempSync(path.join(os.tmpdir(), 'oasis-envkey-'));
  try {
    const clean = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(OASIS_|OPENAI_|ANTHROPIC_|GEMINI_|OPENROUTER_|GROQ_|XDG_CONFIG)/.test(name)));
    return spawnSync(process.execPath, [cli, '-p', 'hi'], { cwd: home, encoding: 'utf8', timeout: 20000, env: { ...clean, HOME: home, USERPROFILE: home, OASIS_NO_UPDATE_CHECK: '1', ...env } });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

test('OASIS_BASE_URL without a key says the key is missing, not that nothing is configured', () => {
  const result = run({ OASIS_PROTOCOL: 'openai', OASIS_BASE_URL: 'https://models.example.test/v1', OASIS_MODEL: 'm' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OASIS_BASE_URL is set to https:\/\/models\.example\.test\/v1, but no API key was found/);
  assert.match(result.stderr, /OASIS_API_KEY/);
  assert.doesNotMatch(result.stderr, /No model provider is configured/);
});

test('with nothing set the general setup guidance stays', () => {
  const result = run({});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /No model provider is configured/);
});
