import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';
import { recommendSetup } from '../src/hardware.mjs';

test('the setup page gets a hardware-aware recommendation from the same computer only', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-profile-'));
  const seen = [];
  const profileComputer = async (options) => {
    seen.push(options.configured);
    return recommendSetup({ os: 'darwin', arch: 'arm64', appleSilicon: true, memoryGB: 32, cores: 10, accelerator: 'metal' },
      [{ id: 'ollama', name: 'Ollama', baseURL: 'http://127.0.0.1:11434/v1', running: true, models: ['qwen3:8b'] }]);
  };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env: { OASIS_CONFIG_DIR: path.join(root, 'config') }, token: 'test-runtime-token-0123456789', profileComputer });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  assert.equal((await fetch(base + '/api/system/profile')).status, 401);
  const response = await fetch(base + '/api/system/profile', { headers: { authorization: 'Bearer ' + app.token } });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.primary.route, 'local');
  assert.equal(body.primary.model, 'qwen3:8b');
  assert.match(body.summary, /macOS arm64 · 10 CPU cores · 32 GB memory · Apple Silicon/);
  assert.deepEqual(seen, [false], 'the current provider state is passed through');

  const html = await (await fetch(base + '/')).text();
  assert.match(html, /id="firstRunRecommend"/);
  assert.match(html, /id="updateBanner"/);
});
