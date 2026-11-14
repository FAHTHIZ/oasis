// Regression: /cost before the first message priced nothing ("Cost: unknown
// for this model") because no session existed yet, while the provider was a
// free local server. Command output also broke mid-word at the terminal edge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { wrapCommandOutput } from '../src/cli.mjs';

const SLASH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'slash.mjs');

test('/cost with no session yet prices the saved local provider as free', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-cost-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, 'config.json'), JSON.stringify({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:18777/v1', model: 'mock', keyless: true }));
  // A child process so the config directory is read fresh from the environment.
  const script = 'const { runBuiltinCommand, createUsageTracker } = await import(' + JSON.stringify(SLASH) + '); const r = await runBuiltinCommand("cost", "", { root: process.cwd(), session: null, usage: createUsageTracker() }); console.log(r.output);';
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, OASIS_CONFIG_DIR: dir, OASIS_PRICE_INPUT: '', OASIS_PRICE_OUTPUT: '' }, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Estimated cost: \$0\.00 \(local model\)/);
  assert.doesNotMatch(run.stdout, /unknown/);
});

test('command output word-wraps on a terminal and leaves full-width lines alone', () => {
  const long = 'Session usage: 0 tokens across 0 model requests. Cost: unknown for this model (add pricing).';
  const wrapped = wrapCommandOutput(long, 60).split('\n');
  assert.ok(wrapped.length > 1);
  assert.ok(wrapped.every((row) => row.length <= 60), JSON.stringify(wrapped));
  assert.ok(!/\bt$/.test(wrapped[0]) && wrapped.join(' ').replace(/\s+/g, ' ').includes('unknown for this model'));
  const exact = 'x'.repeat(59) + ' y';
  assert.equal(wrapCommandOutput(exact.slice(0, 60), 60), exact.slice(0, 60));
  assert.equal(wrapCommandOutput('a\n  b', 60), 'a\n  b');
});
