import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const root = process.argv[2];
const { saveConfig, loadConfig } = await import(pathToFileURL(path.join(root, 'src/config.mjs')).href);
const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-eval-config-bounds-'));
try {
  const cases = [
    [{ maxSteps: ' 7 ', maxCommandSeconds: '45' }, 7, 45],
    [{ maxSteps: -5, maxCommandSeconds: 1 }, 1, 5],
    [{ maxSteps: 999, maxCommandSeconds: 9999 }, 30, 600],
    [{ maxSteps: '12junk', maxCommandSeconds: '1e2' }, 12, 120],
    [{ maxSteps: 4.5, maxCommandSeconds: 7.25 }, 12, 120],
    [{ maxSteps: Number.MAX_SAFE_INTEGER + 1, maxCommandSeconds: '9007199254740992' }, 12, 120]
  ];
  for (const [values, expectedSteps, expectedSeconds] of cases) {
    const configPath = path.join(dir, 'config-' + Math.random().toString(36).slice(2) + '.json');
    await saveConfig({
      protocol: 'openai-compatible',
      baseURL: 'https://provider.example/v1',
      model: 'fixture-model',
      apiKey: '',
      ...values
    }, { configPath, env: {} });
    const saved = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(saved.maxSteps, expectedSteps, JSON.stringify(values));
    assert.equal(saved.maxCommandSeconds, expectedSeconds, JSON.stringify(values));
  }
  const legacyPath = path.join(dir, 'legacy.json');
  await writeFile(legacyPath, JSON.stringify({
    protocol: 'openai-compatible',
    baseURL: 'https://provider.example/v1',
    model: 'fixture-model',
    apiKey: '',
    maxSteps: '8oops',
    maxCommandSeconds: 12.5
  }));
  const legacy = await loadConfig({ configPath: legacyPath, env: {} });
  assert.equal(legacy.maxSteps, 12);
  assert.equal(legacy.maxCommandSeconds, 120);

  const regressionTests = await readFile(path.join(root, 'test/config-bounds.test.mjs'), 'utf8');
  assert.match(regressionTests, /malformed, fractional, exponent, and unsafe values/);
  assert.match(regressionTests, /loaded configuration applies strict bounds/);
} finally {
  await rm(dir, { recursive: true, force: true });
}
