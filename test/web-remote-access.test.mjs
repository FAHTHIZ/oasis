import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';
import { createAuthLimiter } from '../src/remote-access.mjs';

const TOKEN = 'remote-access-test-token-0123456789abcdef';

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => { let json = null; try { json = JSON.parse(body); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
    });
    req.on('error', reject);
    req.end();
  });
}

async function start(t, extra = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-remote-'));
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env: { OASIS_CONFIG_DIR: path.join(root, 'config') }, token: TOKEN, refreshModelCatalog: false, ...extra });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  return app;
}

const auth = { authorization: 'Bearer ' + TOKEN };

test('domain Host headers are refused unless configured', async (t) => {
  const app = await start(t);
  assert.equal((await request(app.port, '/api/status', { ...auth, host: 'oasis.example.com' })).status, 421);
  assert.equal((await request(app.port, '/api/status', auth)).status, 200);
});

test('a public URL behind a trusted proxy works and allows provider setup over HTTPS', async (t) => {
  const app = await start(t, { publicUrl: 'https://oasis.example.com', trustProxy: true });
  const proxied = { ...auth, host: '127.0.0.1:' + app.port, 'x-forwarded-host': 'oasis.example.com', 'x-forwarded-proto': 'https', 'x-forwarded-for': '198.51.100.7', origin: 'https://oasis.example.com' };
  const ok = await request(app.port, '/api/status', proxied);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.providerSetupAvailable, true);
  const plain = await request(app.port, '/api/status', { ...proxied, 'x-forwarded-proto': 'http', origin: 'http://oasis.example.com' });
  assert.equal(plain.status, 200);
  assert.equal(plain.json.providerSetupAvailable, false, 'keys are never accepted over plain HTTP from another device');
  assert.equal((await request(app.port, '/api/status', { ...proxied, origin: 'https://evil.example' })).status, 421);
});

test('forwarded requests are not treated as local when the proxy is not trusted', async (t) => {
  const app = await start(t, { allowedHosts: ['oasis.example.com'] });
  const local = await request(app.port, '/api/status', auth);
  assert.equal(local.json.providerSetupAvailable, true);
  const forwarded = await request(app.port, '/api/status', { ...auth, host: 'oasis.example.com', 'x-forwarded-for': '198.51.100.7', 'x-forwarded-proto': 'https' });
  assert.equal(forwarded.status, 200);
  assert.equal(forwarded.json.providerSetupAvailable, false);
});

test('repeated wrong access keys are rate limited', async (t) => {
  const app = await start(t, { authLimiter: createAuthLimiter({ max: 3, windowMs: 60_000, lockMs: 60_000 }) });
  for (let i = 0; i < 3; i++) assert.equal((await request(app.port, '/api/status', { authorization: 'Bearer wrong-key-' + i })).status, 401);
  const locked = await request(app.port, '/api/status', auth);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers['retry-after']) > 0);
});
