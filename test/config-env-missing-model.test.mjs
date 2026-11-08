import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';

// Found while wiring the OmniRoute benchmark: OASIS_BASE_URL and OASIS_API_KEY
// were set but not OASIS_MODEL, and the error only said "Run oasis setup".
test('an OASIS_BASE_URL without a model names the missing variable and the connect command', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-config-env-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { OASIS_BASE_URL: 'http://127.0.0.1:20128/v1/', OASIS_API_KEY: 'sk-test' };
  await assert.rejects(loadConfig({ env, configPath: path.join(dir, 'missing.json') }), (error) => {
    assert.match(error.message, /OASIS_MODEL/);
    assert.match(error.message, /oasis connect http:\/\/127\.0\.0\.1:20128\/v1 /);
    return true;
  });
});

