import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';

async function dir(t) {
  const d = await mkdtemp(path.join(os.tmpdir(), 'oasis-vendor-base-'));
  t.after(() => rm(d, { recursive: true, force: true }));
  return d;
}

// Found in a credential-leak check: OPENAI_BASE_URL was ignored, so OPENAI_API_KEY went to api.openai.com.
test('OPENAI_BASE_URL is honoured when nothing OASIS-specific is set or saved', async (t) => {
  const d = await dir(t);
  const config = await loadConfig({ env: { OPENAI_BASE_URL: 'https://proxy.example.com/v1', OPENAI_API_KEY: 'sk-x', OASIS_MODEL: 'm' }, configPath: path.join(d, 'none.json') });
  assert.equal(config.baseURL, 'https://proxy.example.com/v1');
  assert.equal(config.protocol, 'openai-compatible');
  assert.equal(config.apiKey, 'sk-x');
});

test('ANTHROPIC_BASE_URL selects the Anthropic protocol', async (t) => {
  const d = await dir(t);
  const config = await loadConfig({ env: { ANTHROPIC_BASE_URL: 'https://gw.example.com', ANTHROPIC_API_KEY: 'sk-ant', OASIS_MODEL: 'claude-x' }, configPath: path.join(d, 'none.json') });
  assert.equal(config.baseURL, 'https://gw.example.com');
  assert.equal(config.protocol, 'anthropic');
});

test('OASIS_BASE_URL and a saved setup win over the vendor variables', async (t) => {
  const d = await dir(t);
  const env = { OPENAI_BASE_URL: 'https://proxy.example.com/v1', OASIS_BASE_URL: 'https://mine.example.com/v1', OASIS_MODEL: 'm', OASIS_API_KEY: 'k' };
  assert.equal((await loadConfig({ env, configPath: path.join(d, 'none.json') })).baseURL, 'https://mine.example.com/v1');
  const saved = path.join(d, 'config.json');
  await writeFile(saved, JSON.stringify({ protocol: 'openai-compatible', baseURL: 'https://saved.example.com/v1', model: 's', apiKey: 'k' }));
  const config = await loadConfig({ env: { OPENAI_BASE_URL: 'https://proxy.example.com/v1' }, configPath: saved });
  assert.equal(config.baseURL, 'https://saved.example.com/v1');
});

test('a vendor base URL without a model names the variable it came from', async (t) => {
  const d = await dir(t);
  await assert.rejects(loadConfig({ env: { OPENAI_BASE_URL: 'https://proxy.example.com/v1' }, configPath: path.join(d, 'none.json') }), /OPENAI_BASE_URL/);
});
