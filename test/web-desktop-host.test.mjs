// The desktop app hosts the same web server with two hooks: it stores provider
// keys itself (OS key store) and answers update requests from its installer-
// capable updater. These tests pin both hooks without Electron.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

async function withServer(t, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-desktop-host-'));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, token: 'test-runtime-token-0123456789', env, ...options });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return { base: 'http://127.0.0.1:' + app.port, headers: { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' }, root };
}

test('a desktop host stores the verified provider itself and no config file is written', async (t) => {
  const provider = createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'probe', type: 'function', function: { name: 'oasis_connection_probe', arguments: '{"ready":true}' } }] } }] }));
  });
  await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => provider.close(resolve)));
  const received = [];
  const { base, headers, root } = await withServer(t, { onProviderConfig: async (config) => { received.push(config); } });
  const baseURL = 'http://127.0.0.1:' + provider.address().port + '/v1';
  const response = await fetch(base + '/api/provider/config', {
    method: 'POST', headers,
    body: JSON.stringify({ protocol: 'openai-compatible', baseURL, model: 'm', apiKey: 'sk-desktop-secret-value' })
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.saved, true);
  assert.ok(!JSON.stringify(body).includes('sk-desktop-secret-value'), 'the key is never echoed');
  assert.deepEqual(received, [{ protocol: 'openai-compatible', baseURL, model: 'm', apiKey: 'sk-desktop-secret-value' }]);
  await assert.rejects(stat(path.join(root, 'config', 'config.json')), 'the plaintext config file is left to the host');
});

test('a desktop host answers update checks and installs only through its own prompt', async (t) => {
  const calls = [];
  const status = { phase: 'available', current: '1.0.0', available: true, canInstall: true, latest: { version: '9.9.9', url: 'https://github.com/FAHTHIZ/oasis/releases/tag/v9.9.9' }, checkedAt: '2026-11-10T00:00:00Z' };
  const appUpdate = {
    status: () => { calls.push('status'); return status; },
    check: async () => { calls.push('check'); return status; },
    skip: async (version) => { calls.push('skip:' + version); return { ...status, skippedVersion: version }; },
    prompt: async () => { calls.push('prompt'); return status; }
  };
  const { base, headers } = await withServer(t, { appUpdate, updateFetchImpl: async () => { throw new Error('the CLI check must not run'); } });
  const got = await (await fetch(base + '/api/app/update', { headers })).json();
  assert.equal(got.host, 'desktop');
  assert.equal(got.canInstall, true);
  assert.equal(got.latest.version, '9.9.9');
  await fetch(base + '/api/app/update?refresh=1', { headers });
  assert.ok(calls.includes('check'), 'Check now asks the desktop updater');

  const skip = await (await fetch(base + '/api/app/update', { method: 'POST', headers, body: JSON.stringify({ action: 'skip', version: '9.9.9' }) })).json();
  assert.equal(skip.skippedVersion, '9.9.9');

  const install = await fetch(base + '/api/app/update', { method: 'POST', headers, body: JSON.stringify({ action: 'install' }) });
  assert.equal(install.status, 202, 'answers before the app may quit to install');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.includes('prompt'), 'installation goes through the native confirmation prompt');
  assert.ok(!calls.includes('install'), 'the page can never install without that prompt');
});
