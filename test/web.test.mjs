import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';

async function tempDir() {
  return await mkdtemp(path.join(os.tmpdir(), 'oasis-web-test-'));
}

test('browser runtime serves the app but requires a bearer token for every agent API', async (t) => {
  const root = await tempDir();
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config') };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789' });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const home = await fetch(base + '/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="view-agent"/);
  assert.equal(home.headers.get('x-content-type-options'), 'nosniff');

  const anonymous = await fetch(base + '/api/status');
  assert.equal(anonymous.status, 401);
  assert.match((await anonymous.json()).error, /connection token/i);

  const auth = { authorization: 'Bearer ' + app.token };
  const status = await fetch(base + '/api/status', { headers: auth });
  assert.equal(status.status, 200);
  const statusBody = await status.json();
  assert.equal(statusBody.connected, true);
  assert.equal(statusBody.providerConfigured, false);
  assert.equal(statusBody.approvalMode, 'per-action');
  assert.equal('apiKey' in statusBody, false);

  const sessions = await fetch(base + '/api/sessions', { headers: auth });
  assert.equal(sessions.status, 200);
  assert.deepEqual((await sessions.json()).sessions, []);
});

test('web runtime rejects cross-origin API access even with the runtime token', async (t) => {
  const root = await tempDir();
  const app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env: { OASIS_CONFIG_DIR: path.join(root, 'config') },
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const response = await fetch('http://127.0.0.1:' + app.port + '/api/status', {
    headers: { authorization: 'Bearer ' + app.token, origin: 'http://attacker.example' }
  });
  assert.equal(response.status, 421);
  assert.match((await response.json()).error, /same-origin/i);
});

test('web runtime validates message sizes and approval decisions before queueing work', async (t) => {
  const root = await tempDir();
  const app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env: { OASIS_CONFIG_DIR: path.join(root, 'config') },
    token: 'test-runtime-token-0123456789'
  });
  t.after(async () => {
    await app.close();
    await rm(root, { recursive: true, force: true });
  });

  const response = await fetch('http://127.0.0.1:' + app.port + '/api/chat', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' },
    body: JSON.stringify({ message: '' })
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /enter a task/i);
});
