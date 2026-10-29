import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { loadConfig, saveConfig } from '../src/config.mjs';
import { maxOutputTokensFor, thinkingBudgetFor } from '../src/agent.mjs';

test('configuration integer settings reject partial, fractional and exponent strings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  await writeFile(configPath, JSON.stringify({ maxCommandSeconds: '45seconds', contextWindow: '8000tokens', thinkingBudget: '12000budget', maxOutputTokens: '6000tokens' }), 'utf8');

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
  assert.equal(Object.hasOwn(config, 'contextWindow'), false, 'malformed saved context windows must be ignored');
  assert.equal(Object.hasOwn(config, 'thinkingBudget'), false, 'malformed saved thinking budgets must be ignored');
  assert.equal(Object.hasOwn(config, 'maxOutputTokens'), false, 'malformed saved output limits must be ignored');
});

test('saved optional model budgets reject partial integer strings on write', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-extra-bounds-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configPath = path.join(root, 'config.json');
  await saveConfig({
    protocol: 'openai-compatible',
    baseURL: 'http://127.0.0.1:11434/v1',
    model: 'local-model',
    contextWindow: '8000tokens',
    thinkingBudget: '12000budget',
    maxOutputTokens: '6000tokens'
  }, { configPath, env: {} });

  const saved = JSON.parse(await (await import('node:fs/promises')).readFile(configPath, 'utf8'));
  assert.equal(Object.hasOwn(saved, 'contextWindow'), false);
  assert.equal(Object.hasOwn(saved, 'thinkingBudget'), false);
  assert.equal(Object.hasOwn(saved, 'maxOutputTokens'), false);
});

test('runtime model budgets ignore malformed optional integer values', () => {
  assert.equal(maxOutputTokensFor({ model: 'custom-model', maxOutputTokens: '16000tokens' }, { OASIS_MAX_OUTPUT_TOKENS: '20000junk' }), 8192);
  assert.equal(maxOutputTokensFor({ model: 'custom-model' }, { OASIS_MAX_OUTPUT_TOKENS: '16384' }), 16384);
  assert.equal(thinkingBudgetFor('please think', { thinkingBudget: '12000budget' }, { OASIS_THINKING_BUDGET: '32000tokens' }), 4000);
  assert.equal(thinkingBudgetFor('', { thinkingBudget: 12000 }, {}), 12000);
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
