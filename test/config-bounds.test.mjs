import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';

test('configuration integer settings reject partial, fractional and exponent strings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ maxCommandSeconds: '45seconds' }), 'utf8');

  const config = await loadConfig({
    configPath,
    env: {
      OASIS_CONFIG_DIR: root,
      OASIS_MAX_STEPS: '12junk',
      OASIS_MAX_TOOL_CALLS: '12.5',
      OASIS_MAX_TOKENS: '1e6'
    }
  });

  assert.equal(config.maxSteps, 60, 'partial integer input must use the safe default');
  assert.equal(config.maxToolCalls, 300, 'fractional input must not be parsed as an integer prefix');
  assert.equal(config.maxTokens, 2_000_000, 'scientific notation must not be parsed as a numeric prefix');
  assert.equal(config.maxCommandSeconds, 120, 'malformed saved settings must not be silently truncated');
});

test('configuration integer settings retain valid values and enforce bounds', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  const config = await loadConfig({
    configPath: path.join(root, 'missing-config.json'),
    env: {
      OASIS_CONFIG_DIR: root,
      OASIS_MAX_STEPS: '999',
      OASIS_MAX_TOOL_CALLS: '1',
      OASIS_MAX_TOKENS: '9999'
    }
  });

  assert.equal(config.maxSteps, 400, 'valid integers above the configured maximum are clamped');
  assert.equal(config.maxToolCalls, 1, 'the minimum tool-call bound remains inclusive');
  assert.equal(config.maxTokens, 10_000, 'the minimum token budget remains inclusive');
});
