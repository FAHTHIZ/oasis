import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { saveConfig, loadConfig } from '../src/config.mjs';

async function file(t, saved) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-save-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = path.join(dir, 'config.json');
  await writeFile(configPath, JSON.stringify(saved));
  return configPath;
}

const base = { protocol: 'openai-compatible', baseURL: 'https://gateway.example.com/v1', model: 'gpt-5.5', apiKey: 'sk-old',
  maxSteps: 200, maxToolCalls: 900, temperature: 0.3, autoCompactPercent: 70, reasoningEffort: 'high', promptCache: false,
  customHeaders: { 'X-Team': 'core' }, betas: ['b1'], contextWindow: 300000, maxOutputTokens: 64000 };

test('a new API key for the same provider keeps every other setting', async (t) => {
  const configPath = await file(t, base);
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'https://gateway.example.com/v1', model: 'gpt-5.5', apiKey: 'sk-new' }, { configPath });
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.apiKey, 'sk-new');
  for (const key of ['maxSteps', 'maxToolCalls', 'temperature', 'autoCompactPercent', 'reasoningEffort', 'promptCache', 'contextWindow', 'maxOutputTokens']) assert.deepEqual(saved[key], base[key], key);
  assert.deepEqual(saved.customHeaders, { 'X-Team': 'core' });
  assert.deepEqual(saved.betas, ['b1']);
});

test('switching provider keeps preferences but drops endpoint headers and model limits', async (t) => {
  const configPath = await file(t, base);
  await saveConfig({ protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'claude-sonnet-5-5', apiKey: 'sk-ant' }, { configPath });
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.maxSteps, 200);
  assert.equal(saved.temperature, 0.3);
  assert.equal(saved.reasoningEffort, 'high');
  for (const key of ['customHeaders', 'betas', 'contextWindow', 'maxOutputTokens']) assert.equal(saved[key], undefined, key);
});

test('a new model on the same endpoint keeps headers but not the old context window', async (t) => {
  const configPath = await file(t, base);
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'https://gateway.example.com/v1/', model: 'gpt-6', apiKey: 'sk-old' }, { configPath });
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.deepEqual(saved.customHeaders, { 'X-Team': 'core' });
  assert.equal(saved.contextWindow, undefined);
});

test('runtime-only values from loadConfig are never written back', async (t) => {
  const configPath = await file(t, base);
  const env = { ...process.env, OASIS_CONFIG_PATH: configPath, OASIS_API_KEY_HELPER: 'echo secret', OASIS_API_KEY: '', OPENAI_API_KEY: '', OASIS_BASE_URL: '', OASIS_MODEL: '', OASIS_PROTOCOL: '' };
  const loaded = await loadConfig({ env, configPath });
  await saveConfig({ ...loaded, apiKey: 'sk-x' }, { configPath });
  const saved = JSON.parse(await readFile(configPath, 'utf8'));
  for (const key of ['configPath', 'configured', 'apiKeyHelper']) assert.equal(saved[key], undefined, key);
  assert.equal(saved.temperature, 0.3);
});
