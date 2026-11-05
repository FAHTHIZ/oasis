import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, saveConfig } from '../src/config.mjs';

const provider = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'm', apiKey: '' };

test('saving over an invalid config keeps a copy of it first', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-cfg-'));
  const configPath = path.join(dir, 'config.json');
  const broken = '{ "model": "m", "theme": "dark", }\n';
  await mkdir(dir, { recursive: true });
  await writeFile(configPath, broken);
  await assert.rejects(loadConfig({ configPath, env: {} }), (error) => error.message.includes(configPath) && /oasis setup/.test(error.message));
  const seen = [];
  await saveConfig(provider, { configPath, env: {}, onInvalidConfig: (info) => seen.push(info) });
  assert.equal(seen.length, 1);
  assert.match(path.basename(seen[0].backupPath), /^config\.json\.invalid-/);
  assert.equal(await readFile(seen[0].backupPath, 'utf8'), broken);
  assert.equal(JSON.parse(await readFile(configPath, 'utf8')).model, 'm');

  // A valid config is merged as before, with no backup.
  await saveConfig({ ...provider, model: 'n' }, { configPath, env: {}, onInvalidConfig: () => assert.fail('valid config treated as invalid') });
  assert.equal((await readdir(dir)).filter((name) => name.includes('.invalid-')).length, 1);
});

test('an empty or missing config is replaced without a backup', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-cfg-'));
  const configPath = path.join(dir, 'config.json');
  const fail = () => assert.fail('no backup expected');
  await saveConfig(provider, { configPath, env: {}, onInvalidConfig: fail });
  await writeFile(configPath, '  \n');
  await saveConfig(provider, { configPath, env: {}, onInvalidConfig: fail });
  assert.deepEqual((await readdir(dir)).sort(), ['config.json']);
});
