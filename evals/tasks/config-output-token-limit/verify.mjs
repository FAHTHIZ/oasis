import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { spawnSync } from 'node:child_process';
const workspace = process.argv[2];
for (const args of [['scripts/check-site.mjs'], ['--test']]) {
  const checked = spawnSync(process.execPath, args, { cwd: workspace, encoding: 'utf8', timeout: 120000 });
  if (checked.error || checked.status !== 0) throw new Error('Existing repository checks failed: ' + String(checked.error || checked.status) + '\n' + String(checked.stdout || '').slice(-4000) + String(checked.stderr || '').slice(-4000));
}
const { loadConfig, saveConfig } = await import(pathToFileURL(path.join(workspace, 'src', 'config.mjs')).href);
const temp = await mkdtemp(path.join(os.tmpdir(), 'oasis-eval-config-'));
try {
  const configPath = path.join(temp, 'config.json');
  const base = { protocol: 'openai-compatible', baseURL: 'https://provider.example/v1', model: 'fixture', apiKey: 'fixture-key' };
  await saveConfig({ ...base, maxOutputTokens: 500 }, { configPath, env: {} });
  let saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.maxOutputTokens, 1024, 'saved low values are clamped');
  let loaded = await loadConfig({ configPath, env: {} });
  assert.equal(loaded.maxOutputTokens, 1024, 'the low value survives reload');
  await saveConfig({ ...base, maxOutputTokens: 200000 }, { configPath, env: {} });
  saved = JSON.parse(await readFile(configPath, 'utf8'));
  assert.equal(saved.maxOutputTokens, 131072, 'saved high values are clamped');
  loaded = await loadConfig({ configPath, env: {} });
  assert.equal(loaded.maxOutputTokens, 131072, 'the high value survives reload');
  await saveConfig(base, { configPath, env: {} });
  loaded = await loadConfig({ configPath, env: {} });
  assert.equal(loaded.maxOutputTokens, 8192, 'the default is stable');
} finally {
  await rm(temp, { recursive: true, force: true });
}
