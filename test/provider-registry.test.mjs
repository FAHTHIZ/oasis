import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BUILTIN_PROVIDERS, providerRegistry, getProvider, providerApiKey, providerForEndpoint, useProviderSettings } from '../src/provider-registry.mjs';
import { parseFallbackChain, resolveFallbackConfig } from '../src/fallback-chain.mjs';
import { DEFAULT_BASE_URL, DEFAULT_MODEL, inferSetupProviderPreset } from '../src/config.mjs';
import { LOCAL_SERVERS } from '../src/hardware.mjs';
import { loadSettings } from '../src/settings.mjs';

test('config defaults and local-server discovery come from the registry', () => {
  assert.equal(DEFAULT_BASE_URL, BUILTIN_PROVIDERS.openai.baseURL);
  assert.equal(DEFAULT_MODEL, BUILTIN_PROVIDERS.openai.model);
  assert.deepEqual(LOCAL_SERVERS.map((s) => s.id), ['ollama', 'lmstudio', 'llamacpp', 'jan', 'vllm']);
  assert.ok(Object.isFrozen(BUILTIN_PROVIDERS.groq) && Object.isFrozen(BUILTIN_PROVIDERS.groq.keyEnv));
});

test('settings providers add and override entries; invalid ones are ignored', () => {
  const settings = { providers: {
    acme: { protocol: 'openai-compatible', baseURL: 'https://llm.acme.test/v1', keyEnv: ['ACME_KEY'], model: 'acme-coder' },
    groq: { baseURL: 'https://groq-proxy.test/v1' },
    broken: { protocol: 'carrier-pigeon', baseURL: 'https://x.test' },
    'Bad Id!': { protocol: 'openai-compatible', baseURL: 'https://x.test' },
    nourl: { protocol: 'openai-compatible', baseURL: 'file:///etc/passwd' }
  } };
  const registry = providerRegistry({ settings, env: {} });
  assert.equal(registry.acme.baseURL, 'https://llm.acme.test/v1');
  assert.equal(registry.groq.baseURL, 'https://groq-proxy.test/v1');
  assert.deepEqual([...registry.groq.keyEnv], ['GROQ_API_KEY']);
  assert.equal(registry.broken, undefined);
  assert.equal(registry.nourl, undefined);
  assert.equal(Object.keys(registry).some((id) => /bad/i.test(id)), false);
  assert.equal(providerApiKey(registry.acme, { ACME_KEY: 'k1' }), 'k1');
});

test('environment re-points a provider and fallback chains accept custom ids', () => {
  const env = { OASIS_PROVIDER_OLLAMA_BASE_URL: 'http://gpu-box:11434/v1', MY_GW_KEY: 'gw' };
  assert.equal(getProvider('ollama', { env, settings: {} }).baseURL, 'http://gpu-box:11434/v1');
  useProviderSettings({ 'my-gw': { protocol: 'openai-compatible', baseURL: 'https://gw.test/v1', keyEnv: 'MY_GW_KEY' } });
  try {
    const [entry] = parseFallbackChain('my-gw:qwen3-coder');
    assert.deepEqual(entry, { id: 'my-gw:qwen3-coder', provider: 'my-gw', model: 'qwen3-coder' });
    const config = resolveFallbackConfig(entry, { protocol: 'anthropic', baseURL: 'https://api.anthropic.com', model: 'm', apiKey: 'a', contextWindow: 1 }, env);
    assert.equal(config.baseURL, 'https://gw.test/v1');
    assert.equal(config.apiKey, 'gw');
    assert.equal(config.contextWindow, undefined);
    // Model ids that merely contain a colon stay models on the current provider.
    assert.deepEqual(parseFallbackChain('gpt-oss:20b')[0].provider, '');
  } finally { useProviderSettings({}); }
});

test('endpoint inference matches host and port, treating loopback names alike', () => {
  assert.equal(providerForEndpoint('http://localhost:11434/v1'), 'ollama');
  assert.equal(providerForEndpoint('https://generativelanguage.googleapis.com/v1beta/openai/'), 'gemini');
  assert.equal(providerForEndpoint('https://api.openai.com/v1', 'anthropic'), '');
  assert.equal(inferSetupProviderPreset({ configured: true, protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:1234/v1' }), 'custom');
});

test('a repository cannot define providers; user settings can', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-reg-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-reg-repo-'));
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ providers: { openai: { baseURL: 'https://evil.test/v1' } } }));
  const env = { OASIS_CONFIG_DIR: home, HOME: home };
  try {
    const repoOnly = await loadSettings(root, { env });
    assert.equal(repoOnly.providers, undefined);
    assert.equal(getProvider('openai').baseURL, 'https://api.openai.com/v1');
    await writeFile(path.join(home, 'settings.json'), JSON.stringify({ providers: { acme: { protocol: 'anthropic', baseURL: 'https://claude-gw.test' } } }));
    const user = await loadSettings(root, { env });
    assert.equal(user.providers.acme.baseURL, 'https://claude-gw.test');
    assert.equal(getProvider('acme').protocol, 'anthropic');
  } finally { useProviderSettings({}); }
});

test('a custom gateway can name the models.dev provider whose limits apply', async () => {
  const { providerForBaseURL } = await import('../src/model-catalog.mjs');
  assert.equal(providerForBaseURL('https://claude-gw.corp.test/v1', {}), null);
  useProviderSettings({ corpgw: { protocol: 'anthropic', baseURL: 'https://claude-gw.corp.test', catalog: 'anthropic' }, bad: { protocol: 'anthropic', baseURL: 'https://bad.test', catalog: '../x' } });
  try {
    assert.equal(providerForBaseURL('https://claude-gw.corp.test/v1', {}), 'anthropic');
    assert.equal(getProvider('bad').catalog, undefined);
    assert.equal(providerForBaseURL('https://api.groq.com/openai/v1', {}), 'groq');
  } finally { useProviderSettings({}); }
});
