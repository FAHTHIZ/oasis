import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { headlessSetupErrorOutput } from '../src/headless.mjs';

const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));

function runUnconfigured(t, args) {
  return mkdtemp(path.join(os.tmpdir(), 'oasis-setup-err-')).then((dir) => {
    t.after(() => rm(dir, { recursive: true, force: true }));
    const env = { ...process.env, OASIS_CONFIG_DIR: dir, HOME: dir, OASIS_DISABLE_UPDATE_CHECK: '1' };
    for (const key of Object.keys(env)) if (/^(OASIS_(PROTOCOL|BASE_URL|MODEL|API_KEY)|OPENAI_API_KEY|ANTHROPIC_API_KEY|GEMINI_API_KEY|GOOGLE_API_KEY|OPENROUTER_API_KEY|GROQ_API_KEY|DEEPSEEK_API_KEY|MISTRAL_API_KEY|XAI_API_KEY)$/.test(key)) delete env[key];
    return spawnSync(process.execPath, [cli, ...args], { cwd: dir, env, input: '', encoding: 'utf8', timeout: 60000 });
  });
}

test('headless setup errors keep stdout parseable in JSON modes', () => {
  const json = headlessSetupErrorOutput(new Error('No model provider is configured.'), 'json');
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.type, 'result');
  assert.equal(parsed.is_error, true);
  assert.equal(parsed.subtype, 'error_during_execution');
  assert.match(parsed.result, /No model provider/);
  assert.match(json.stderr, /^OASIS error: No model provider/);
  assert.equal(JSON.parse(headlessSetupErrorOutput('x', 'stream-json').stdout).is_error, true);
  assert.deepEqual(headlessSetupErrorOutput(new Error('boom'), 'text'), { stdout: '', stderr: 'OASIS error: boom\n' });
});

test('oasis -p without a provider: JSON result on stdout, message on stderr, exit 1', async (t) => {
  const run = await runUnconfigured(t, ['-p', 'hi', '--output-format', 'json']);
  assert.equal(run.status, 1);
  const lines = run.stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'stdout must hold exactly one JSON object: ' + run.stdout);
  const result = JSON.parse(lines[0]);
  assert.equal(result.is_error, true);
  assert.match(result.result, /model provider/);
  assert.match(run.stderr, /OASIS error: .*model provider/);
});

test('oasis -p without a provider in text mode writes nothing to stdout', async (t) => {
  const run = await runUnconfigured(t, ['-p', 'hi']);
  assert.equal(run.status, 1);
  assert.equal(run.stdout, '');
  assert.match(run.stderr, /OASIS error: .*model provider/);
});
