import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { daytonaCommand, daytonaSshSettings, ensureDaytonaSync, normalizeDaytonaSettings, parseSshCommand, provisionDaytona, readDaytonaState } from '../src/daytona-backend.mjs';
import { sshWrap } from '../src/ssh-backend.mjs';

const TOKEN = 'tok_SECRET_abcdef123456';
function fakeDaytona({ initial = null } = {}) {
  const calls = [];
  const sandboxes = new Map(initial ? [[initial.id, { ...initial }]] : []);
  const fetchImpl = async (url, init = {}) => {
    const route = url.replace('https://app.daytona.io/api', '');
    calls.push({ method: init.method, route, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.authorization });
    let match;
    if (init.method === 'POST' && route === '/sandbox') { const box = { id: 'sbx-' + (sandboxes.size + 1), state: 'creating', polls: 0 }; sandboxes.set(box.id, box); return Response.json(box); }
    if ((match = /^\/sandbox\/([\w-]+)$/.exec(route))) {
      const box = sandboxes.get(match[1]);
      if (!box) return new Response('{"message":"not found"}', { status: 404 });
      if (init.method === 'DELETE') { sandboxes.delete(match[1]); return Response.json({}); }
      if (box.state === 'creating' && ++box.polls > 1) box.state = 'started';
      return Response.json(box);
    }
    if ((match = /^\/sandbox\/([\w-]+)\/start$/.exec(route))) { const box = sandboxes.get(match[1]); box.state = 'started'; return Response.json(box); }
    if ((match = /^\/sandbox\/([\w-]+)\/stop$/.exec(route))) { const box = sandboxes.get(match[1]); box.state = 'stopped'; return Response.json(box); }
    if ((match = /^\/sandbox\/([\w-]+)\/ssh-access\?expiresInMinutes=1440$/.exec(route))) return Response.json({ token: TOKEN, sandboxId: match[1], expiresAt: new Date(Date.now() + 86400000).toISOString(), sshCommand: 'ssh ' + TOKEN + '@ssh.app.daytona.io' });
    return new Response('{}', { status: 400 });
  };
  return { calls, sandboxes, fetchImpl };
}
const workspace = () => mkdtempSync(path.join(os.tmpdir(), 'oasis-daytona-'));

test('settings need an API key and validate their fields', () => {
  assert.match(normalizeDaytonaSettings({}, {}).error, /DAYTONA_API_KEY/);
  assert.match(normalizeDaytonaSettings({ snapshot: 'bad name;rm' }, { DAYTONA_API_KEY: 'k' }).error, /snapshot/);
  assert.match(normalizeDaytonaSettings({ remoteRoot: '/x/../etc' }, { DAYTONA_API_KEY: 'k' }).error, /remoteRoot/);
  assert.match(normalizeDaytonaSettings({ apiUrl: 'http://evil.example' }, { DAYTONA_API_KEY: 'k' }).error, /https/);
  const ok = normalizeDaytonaSettings({ snapshot: 'daytonaio/sandbox:0.4', target: 'eu' }, { DAYTONA_API_KEY: 'k' }, '/tmp/proj');
  assert.equal(ok.autoStopInterval, 30);
  assert.equal(ok.remoteRoot, '~/workspace');
  assert.deepEqual(parseSshCommand('ssh abc@ssh.app.daytona.io -p 2222'), { user: 'abc', host: 'ssh.app.daytona.io', port: 2222 });
});

test('first use creates the sandbox, waits for it and writes a private ssh config', async () => {
  const root = workspace();
  try {
    const daytona = normalizeDaytonaSettings({ snapshot: 'daytonaio/sandbox' }, { DAYTONA_API_KEY: 'dtn_key' }, root);
    const api = fakeDaytona();
    const state = await provisionDaytona(daytona, { fetchImpl: api.fetchImpl, sleep: async () => {} });
    assert.equal(state.sandboxId, 'sbx-1');
    const create = api.calls.find((c) => c.route === '/sandbox');
    assert.equal(create.body.snapshot, 'daytonaio/sandbox');
    assert.equal(create.body.autoStopInterval, 30);
    assert.equal(create.body.labels['oasis-workspace'], daytona.label);
    assert.ok(api.calls.every((c) => c.auth === 'Bearer dtn_key'));
    const config = readFileSync(daytona.configFile, 'utf8');
    assert.match(config, new RegExp('User ' + TOKEN));
    assert.match(config, /HostName ssh\.app\.daytona\.io/);
    assert.match(config, /StrictHostKeyChecking accept-new/);
    if (process.platform !== 'win32') assert.equal(statSync(daytona.configFile).mode & 0o777, 0o600);
    assert.ok(!JSON.stringify(readDaytonaState(daytona)).includes(TOKEN), 'the token lives only in the ssh config');

    // The token never reaches the command line.
    const ssh = { ...daytonaSshSettings(daytona), exclude: ['node_modules/'] };
    const wrapped = sshWrap('npm', ['test'], { ssh }, root, { platform: 'linux' });
    assert.ok(!JSON.stringify(wrapped).includes(TOKEN));
    assert.match(wrapped.args[1], /-F/);
    assert.match(wrapped.args[1], /oasis-daytona/);

    // A fresh state skips the API entirely.
    let spawned = 0;
    assert.ok(ensureDaytonaSync(daytona, { run: () => { spawned++; return { status: 0 }; } }).ok);
    assert.equal(spawned, 0);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a stopped sandbox is started again and a deleted one is recreated', async () => {
  const root = workspace();
  try {
    const daytona = normalizeDaytonaSettings({}, { DAYTONA_API_KEY: 'dtn_key' }, root);
    mkdirSync(daytona.stateDir, { recursive: true });
    writeFileSync(daytona.stateFile, JSON.stringify({ sandboxId: 'old', expiresAt: new Date(Date.now() + 86400000).toISOString() }));
    const api = fakeDaytona({ initial: { id: 'old', state: 'stopped' } });
    await provisionDaytona(daytona, { fetchImpl: api.fetchImpl, sleep: async () => {} });
    assert.ok(api.calls.some((c) => c.route === '/sandbox/old/start'));
    assert.ok(!api.calls.some((c) => c.route.includes('ssh-access')), 'an unexpired token is reused');
    api.sandboxes.delete('old');
    const state = await provisionDaytona(daytona, { fetchImpl: api.fetchImpl, sleep: async () => {} });
    assert.notEqual(state.sandboxId, 'old');
    assert.ok(api.calls.some((c) => c.route.includes('ssh-access')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('oasis daytona status, stop and delete', async () => {
  const root = workspace();
  try {
    const daytona = normalizeDaytonaSettings({}, { DAYTONA_API_KEY: 'dtn_key' }, root);
    const api = fakeDaytona();
    assert.match(await daytonaCommand('status', daytona, { fetchImpl: api.fetchImpl }), /no Daytona sandbox yet/);
    await provisionDaytona(daytona, { fetchImpl: api.fetchImpl, sleep: async () => {} });
    assert.match(await daytonaCommand('status', daytona, { fetchImpl: api.fetchImpl }), /sbx-1: started/);
    assert.match(await daytonaCommand('stop', daytona, { fetchImpl: api.fetchImpl }), /Stopped/);
    assert.equal(api.sandboxes.get('sbx-1').state, 'stopped');
    await assert.rejects(() => daytonaCommand('bogus', daytona, { fetchImpl: api.fetchImpl }), /Usage/);
    assert.match(await daytonaCommand('delete', daytona, { fetchImpl: api.fetchImpl }), /Deleted/);
    assert.equal(api.sandboxes.size, 0);
    assert.equal(readFileSync(daytona.configFile, 'utf8'), '');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('resolveSandbox routes the daytona backend through SSH', async () => {
  const root = workspace();
  const saved = process.env.DAYTONA_API_KEY;
  process.env.DAYTONA_API_KEY = 'dtn_key';
  try {
    const daytona = normalizeDaytonaSettings({}, process.env, root);
    mkdirSync(daytona.stateDir, { recursive: true });
    writeFileSync(daytona.stateFile, JSON.stringify({ sandboxId: 'sbx-9abcdef', checkedAt: Date.now(), expiresAt: new Date(Date.now() + 86400000).toISOString() }));
    const { resolveSandbox } = await import('../src/sandbox.mjs');
    const box = resolveSandbox({ sandbox: { enabled: true, backend: 'daytona' } }, root);
    assert.equal(box.backend, 'daytona');
    assert.equal(box.ssh.host, 'oasis-daytona');
    assert.equal(box.ssh.configFile, daytona.configFile);
    assert.match(box.ssh.display, /Daytona sandbox sbx-9abcdef/);
    assert.ok(box.ssh.exclude.includes('.oasis/daytona/'));
  } finally {
    if (saved === undefined) delete process.env.DAYTONA_API_KEY; else process.env.DAYTONA_API_KEY = saved;
    rmSync(root, { recursive: true, force: true });
  }
});
