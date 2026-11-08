import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../src/config.mjs';
import { runtimeConfigFromConnection } from '../src/provider-connect.mjs';

// Found using the web app as a new user: pasting https://text.pollinations.ai/openai
// connected ("Locked in openai-fast") but the app kept asking for a key, because a
// remote endpoint without a key never counted as configured.
test('a remote endpoint proven to work without a key counts as configured', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-keyless-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { OASIS_CONFIG_DIR: dir, HOME: dir };
  const next = runtimeConfigFromConnection({ connection: { protocol: 'openai', baseURL: 'https://text.pollinations.ai/openai', apiKey: '', models: ['openai-fast'] }, model: 'openai-fast' });
  assert.equal(next.keyless, true);
  await saveConfig(next, { env });
  assert.equal((await loadConfig({ env })).configured, true);

  // Switching to a different endpoint does not carry the flag over.
  await saveConfig({ protocol: 'openai-compatible', baseURL: 'https://openrouter.ai/api/v1', model: 'x/y', apiKey: '' }, { env });
  assert.equal((await loadConfig({ env })).configured, false);
});

test('keyed connections are not marked keyless', () => {
  const next = runtimeConfigFromConnection({ connection: { protocol: 'openai', baseURL: 'https://openrouter.ai/api/v1', apiKey: 'sk-or-x', models: ['a'] }, model: 'a' });
  assert.equal(next.keyless, undefined);
});
