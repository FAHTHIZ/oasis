import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { startOasisWebServer } from '../src/web.mjs';
import { oasisVersion } from '../src/version.mjs';

function bump(version) {
  const [major, minor] = version.split('.').map(Number);
  return major + '.' + (minor + 1) + '.0';
}

async function withServer(t, options) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-web-update-'));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'config'), ...(options.env || {}) };
  const app = await startOasisWebServer({ root, host: '127.0.0.1', port: 0, env, token: 'test-runtime-token-0123456789', ...options, env });
  t.after(async () => { await app.close(); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.port;
  const auth = { authorization: 'Bearer ' + app.token, 'content-type': 'application/json' };
  return { base, auth, root };
}

test('the CLI-hosted workspace reports a newer release and the command to install it', async (t) => {
  const next = bump(oasisVersion());
  let calls = 0;
  const updateFetchImpl = async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ tag_name: 'v' + next, name: 'OASIS v' + next, html_url: 'https://github.com/FAHTHIZ/oasis/releases/tag/v' + next, assets: [] }) };
  };
  const { base, auth, root } = await withServer(t, { updateFetchImpl });
  const anonymous = await fetch(base + '/api/app/update');
  assert.equal(anonymous.status, 401, 'update status needs the runtime token like every API');
  const response = await fetch(base + '/api/app/update', { headers: auth });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.host, 'cli');
  assert.equal(body.available, true);
  assert.equal(body.latest.version, next);
  assert.equal(body.command, 'oasis update');
  assert.equal(body.canInstall, false);
  await fetch(base + '/api/app/update', { headers: auth });
  assert.equal(calls, 1, 'the second request is served from the cached check');

  const skip = await fetch(base + '/api/app/update', { method: 'POST', headers: auth, body: JSON.stringify({ action: 'skip', version: next }) });
  assert.equal(skip.status, 200);
  const state = JSON.parse(await readFile(path.join(root, 'config', 'update-state.json'), 'utf8'));
  assert.equal(state.skippedVersion, next);
  const after = await (await fetch(base + '/api/app/update', { headers: auth })).json();
  assert.equal(after.skippedVersion, next);

  const install = await fetch(base + '/api/app/update', { method: 'POST', headers: auth, body: JSON.stringify({ action: 'install' }) });
  assert.equal(install.status, 400);
  assert.match((await install.json()).error, /oasis update/);
});

test('update checks can be turned off for the browser workspace', async (t) => {
  const { base, auth } = await withServer(t, { env: { OASIS_NO_UPDATE_CHECK: '1' }, updateFetchImpl: async () => { throw new Error('must not be called'); } });
  const body = await (await fetch(base + '/api/app/update', { headers: auth })).json();
  assert.equal(body.phase, 'disabled');
  assert.equal(body.available, false);
});

test('network failures are reported without breaking the page', async (t) => {
  const { base, auth } = await withServer(t, { updateFetchImpl: async () => ({ ok: false, status: 503 }) });
  const body = await (await fetch(base + '/api/app/update', { headers: auth })).json();
  assert.equal(body.phase, 'error');
  assert.match(body.error, /503/);
});

test('the desktop host answers from its updater and installs only on request', async (t) => {
  const events = [];
  const status = { phase: 'available', available: true, canInstall: true, current: '1.0.0', latest: { version: '1.1.0' }, checkedAt: '2026-11-05T00:00:00Z' };
  const appUpdate = {
    status: () => status,
    check: async () => { events.push('check'); return status; },
    skip: async (version) => { events.push('skip:' + version); return { ...status, skippedVersion: version }; },
    prompt: async () => { events.push('prompt'); return status; },
    install: async () => { events.push('install'); return status; }
  };
  const { base, auth } = await withServer(t, { appUpdate, updateFetchImpl: async () => { throw new Error('desktop must not use the CLI check'); } });
  const body = await (await fetch(base + '/api/app/update', { headers: auth })).json();
  assert.equal(body.host, 'desktop');
  assert.equal(body.canInstall, true);
  assert.deepEqual(events, [], 'a recent desktop check is reused');
  await fetch(base + '/api/app/update?refresh=1', { headers: auth });
  assert.deepEqual(events, ['check']);
  const install = await fetch(base + '/api/app/update', { method: 'POST', headers: auth, body: JSON.stringify({ action: 'install' }) });
  assert.equal(install.status, 202);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(events, ['check', 'prompt'], 'install opens the native confirmation, it never installs blindly');
  await fetch(base + '/api/app/update', { method: 'POST', headers: auth, body: JSON.stringify({ action: 'skip', version: '1.1.0' }) });
  assert.equal(events.at(-1), 'skip:1.1.0');
  const bad = await fetch(base + '/api/app/update', { method: 'POST', headers: auth, body: JSON.stringify({ action: 'explode' }) });
  assert.equal(bad.status, 400);
});
