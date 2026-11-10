import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { createDesktopProviderSecrets } from '../desktop/provider-secrets.mjs';
import { loadConfig, saveConfig } from '../src/config.mjs';

function fakeStore(available) {
  return {
    isAsyncEncryptionAvailable: async () => available,
    encryptStringAsync: async (value) => Buffer.from('enc:' + value),
    decryptStringAsync: async (value) => ({ result: value.toString().slice(4) })
  };
}

async function setup(t, { available = true, processEnv = {} } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-desktop-provider-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const filePath = path.join(root, 'userData', 'secure-secrets.json');
  const secrets = createDesktopProviderSecrets({ filePath, safeStorage: fakeStore(available), env, processEnv, saveConfig, loadConfig });
  const configFile = () => readFile(path.join(root, 'config', 'config.json'), 'utf8').then(JSON.parse);
  return { env, filePath, secrets, configFile };
}

const provider = { protocol: 'openai-compatible', baseURL: 'https://api.example.test/v1', model: 'm1', apiKey: 'sk-desktop-1234567890' };

test('with an OS key store the key is encrypted and config.json holds only the non-secret details', async (t) => {
  const { env, filePath, secrets, configFile } = await setup(t);
  assert.deepEqual(await secrets.persist(provider), { storage: 'os-key-store' });
  const saved = await configFile();
  assert.equal(saved.model, 'm1');
  assert.ok(!saved.apiKey, 'no plaintext key in config.json');
  assert.ok(!(await readFile(filePath, 'utf8')).includes(provider.apiKey));
  assert.equal(env.OASIS_API_KEY, provider.apiKey, 'the running workspace gets the key');

  delete env.OASIS_API_KEY;
  assert.deepEqual(await secrets.restore(), { source: 'os-key-store' });
  assert.equal(env.OASIS_API_KEY, provider.apiKey, 'restored on the next launch');
});

test('without a key store the desktop app still connects, keeping the key like the CLI does', async (t) => {
  const { env, filePath, secrets, configFile } = await setup(t, { available: false });
  assert.deepEqual(await secrets.persist(provider), { storage: 'config-file' });
  assert.equal((await configFile()).apiKey, provider.apiKey);
  await assert.rejects(stat(filePath), { code: 'ENOENT' });
  assert.equal(env.OASIS_API_KEY, undefined, 'the config file is the single source');
  if (process.platform !== 'win32') {
    const mode = (await stat(path.join(env.OASIS_CONFIG_DIR, 'config.json'))).mode & 0o777;
    assert.equal(mode, 0o600, 'owner-only, same as the CLI');
  }
});

test('a plaintext key left by the CLI moves into the key store on launch, unless it came from the environment', async (t) => {
  const { env, secrets, configFile } = await setup(t);
  await saveConfig(provider, { env });
  assert.deepEqual(await secrets.restore(), { source: 'migrated' });
  assert.ok(!(await configFile()).apiKey);
  assert.equal(env.OASIS_API_KEY, provider.apiKey);

  const other = await setup(t, { processEnv: { OPENAI_API_KEY: 'from-shell' } });
  await saveConfig(provider, { env: other.env });
  assert.deepEqual(await other.secrets.restore(), { source: 'environment' });
  assert.equal((await other.configFile()).apiKey, provider.apiKey, 'left alone');
});

test('switching to a local model with no key removes the stored key', async (t) => {
  const { env, filePath, secrets } = await setup(t);
  await secrets.persist(provider);
  assert.deepEqual(await secrets.persist({ protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:11434/v1', model: 'qwen', apiKey: '' }), { storage: 'none' });
  await assert.rejects(stat(filePath), { code: 'ENOENT' });
  assert.equal(env.OASIS_API_KEY, undefined);
});
