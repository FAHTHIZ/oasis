import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, chmod } from 'node:fs/promises';
import { createKeyPool, parseKeyList, poolKeysFromEnv, maskKey } from '../src/key-pool.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';

test('key lists parse commas, spaces, newlines and comments and drop short junk', () => {
  assert.deepEqual(parseKeyList('key-aaaaaaaa, key-bbbbbbbb\nkey-cccccccc # spare\n# key-dddddddd\nxx'), ['key-aaaaaaaa', 'key-bbbbbbbb', 'key-cccccccc']);
  assert.deepEqual(poolKeysFromEnv({ OASIS_API_KEY_POOL: 'key-bbbbbbbb key-aaaaaaaa' }, 'key-aaaaaaaa'), ['key-aaaaaaaa', 'key-bbbbbbbb']);
  assert.equal(maskKey('sk-secret-1234'), '…1234');
});

test('pool rotates on 429 with cooldown and skips rejected keys', () => {
  let clock = 1000;
  const pool = createKeyPool(['k1-xxxxxxxx', 'k2-xxxxxxxx', 'k3-xxxxxxxx'], { now: () => clock });
  assert.equal(pool.current(), 'k1-xxxxxxxx');
  assert.equal(pool.fail('k1-xxxxxxxx', 429, 5000), 'k2-xxxxxxxx');
  assert.equal(pool.current(), 'k2-xxxxxxxx');
  assert.equal(pool.fail('k2-xxxxxxxx', 401), 'k3-xxxxxxxx');
  assert.equal(pool.fail('k3-xxxxxxxx', 429), '');
  clock += 6000;
  assert.equal(pool.current(), 'k1-xxxxxxxx', 'cooled-down key comes back');
  clock += 3600000;
  assert.notEqual(pool.current(), 'k2-xxxxxxxx');
  assert.ok(pool.status().every((entry) => entry.key.startsWith('…')));
});

test('pool file must be private', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-pool-'));
  try {
    const file = path.join(dir, 'keys');
    await writeFile(file, 'key-11111111\nkey-22222222\n');
    await chmod(file, 0o644);
    assert.throws(() => poolKeysFromEnv({ OASIS_API_KEY_POOL_FILE: file }), /chmod 600/);
    await chmod(file, 0o600);
    assert.deepEqual(poolKeysFromEnv({ OASIS_API_KEY_POOL_FILE: file }), ['key-11111111', 'key-22222222']);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a rate-limited key is swapped for the next pool key within the same request', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-pool-run-'));
  try {
    const seen = [];
    const fetchImpl = async (_url, init) => {
      const auth = init.headers.authorization;
      seen.push(auth);
      if (auth === 'Bearer key-first-0001') return new Response(JSON.stringify({ error: { message: 'Rate limit reached' } }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': '30' } });
      return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok from second key' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const env = { ...process.env, OASIS_API_KEY_POOL: 'key-second-0002', OASIS_CONFIG_DIR: path.join(root, 'cfg') };
    const config = { protocol: 'openai-compatible', baseURL: 'https://pool.example.test/v1', model: 'fixture', apiKey: 'key-first-0001', contextWindow: 200000, maxSteps: 3, maxCommandSeconds: 10 };
    const session = await createSession({ root, config, env });
    const result = await runAgentTurn(session, 'hi', { fetchImpl, env });
    assert.match(result.text, /ok from second key/);
    assert.deepEqual(seen, ['Bearer key-first-0001', 'Bearer key-second-0002']);
    assert.equal(session.apiKeyPool.status()[0].lastStatus, 429);
    const again = await runAgentTurn(session, 'again', { fetchImpl, env });
    assert.match(again.text, /ok from second key/);
    assert.equal(seen.at(-1), 'Bearer key-second-0002', 'cooling key is not retried first');
  } finally { await rm(root, { recursive: true, force: true }); }
});
