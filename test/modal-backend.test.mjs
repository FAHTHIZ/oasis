import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeModalSettings, modalCredentialsPresent, provisionModal, modalSshSettings, modalCommand, ensureModalSync, sshConfigText, imageCommands, readModalState } from '../src/modal-backend.mjs';
import { resolveSandbox } from '../src/sandbox.mjs';

const ENV = { MODAL_TOKEN_ID: 'ak-x', MODAL_TOKEN_SECRET: 'as-y' };
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'oasis-modal-'));

function fakeSdk({ running = new Set(), created = [], terminated = [] } = {}) {
  let n = 0;
  const sandboxFor = (id) => ({
    sandboxId: id,
    async poll() { return running.has(id) ? null : 0; },
    async waitUntilReady() {},
    async tunnels() { return { 22: { host: 'r1.modal.host', port: 443, unencryptedHost: 'r2.modal.host', unencryptedPort: 40000 + n } }; },
    async terminate() { terminated.push(id); running.delete(id); }
  });
  class ModalClient {
    constructor(params) { this.params = params; }
    close() {}
    apps = { fromName: async (name, opts) => ({ name, opts }) };
    images = { fromRegistry: (tag) => ({ tag, dockerfileCommands: (cmds) => ({ tag, cmds }) }) };
    sandboxes = {
      create: async (app, image, params) => { n += 1; const id = 'sb-' + n; running.add(id); created.push({ app, image, params }); return sandboxFor(id); },
      fromId: async (id) => { if (!id.startsWith('sb-')) throw new Error('not found'); return sandboxFor(id); }
    };
  }
  return { ModalClient, Probe: { withTcp: (port) => ({ tcp: port }) }, created, terminated, running };
}

test('modal settings need credentials and validate values', () => {
  const home = tmp();
  assert.equal(modalCredentialsPresent({}, home), false);
  assert.match(normalizeModalSettings({}, {}, tmp(), home).error, /MODAL_TOKEN_ID/);
  writeFileSync(path.join(home, '.modal.toml'), '[default]\ntoken_id = "ak"\ntoken_secret = "as"\n');
  assert.equal(modalCredentialsPresent({}, home), true);
  const ok = normalizeModalSettings({}, ENV, tmp(), home);
  assert.equal(ok.image, 'node:22-bookworm');
  assert.equal(ok.timeoutMinutes, 720);
  assert.match(ok.label, /^oasis-[0-9a-f]{12}$/);
  assert.match(normalizeModalSettings({ timeoutMinutes: 2000 }, ENV, tmp(), home).error, /timeoutMinutes/);
  assert.match(normalizeModalSettings({ image: 'bad image; rm' }, ENV, tmp(), home).error, /image/);
  assert.match(normalizeModalSettings({ gpu: 'A100 $(x)' }, ENV, tmp(), home).error, /gpu/);
  assert.match(normalizeModalSettings({ remoteRoot: '/a/../b' }, ENV, tmp(), home).error, /remoteRoot/);
  assert.equal(normalizeModalSettings({}, { ...ENV, OASIS_MODAL_IMAGE: 'python:3.12' }, tmp(), home).image, 'python:3.12');
});

test('image steps add sshd and rsync, then the user setup', () => {
  const steps = imageCommands({ setup: ['pip install uv', 'ENV FOO=1'] });
  assert.match(steps[0], /openssh-server/);
  assert.match(steps[0], /rsync/);
  assert.equal(steps.at(-2), 'RUN pip install uv');
  assert.equal(steps.at(-1), 'ENV FOO=1');
});

test('ssh config strips anything that could inject options', () => {
  const text = sshConfigText({ keyFile: '/k', knownHosts: '/h' }, { host: 'evil.host\n  ProxyCommand x', port: '22x' });
  assert.doesNotMatch(text, /\n\s*ProxyCommand/);
  assert.match(text, /HostName evil.hostProxyCommandx/);
});

test('provision starts a sandbox once, reuses it, and replaces it when it ends', async () => {
  const root = tmp();
  const modal = normalizeModalSettings({ gpu: 'T4', cpu: 2 }, ENV, root, tmp());
  const sdk = fakeSdk();
  const first = await provisionModal(modal, { sdk, now: () => 1000 });
  assert.equal(first.sandboxId, 'sb-1');
  assert.equal(first.host, 'r2.modal.host');
  assert.equal(sdk.created.length, 1);
  const params = sdk.created[0].params;
  assert.deepEqual(params.unencryptedPorts, [22]);
  assert.equal(params.gpu, 'T4');
  assert.equal(params.cpu, 2);
  assert.equal(params.timeoutMs, 720 * 60000);
  assert.match(params.env.OASIS_SSH_PUBLIC_KEY, /^ssh-ed25519 /);
  assert.match(params.command.join(' '), /PasswordAuthentication=no/);
  assert.equal(sdk.created[0].app.name, 'oasis');
  assert.equal(statSync(modal.stateFile).mode & 0o777, 0o600);
  assert.equal(statSync(modal.keyFile).mode & 0o777, 0o600);
  assert.match(readFileSync(modal.configFile, 'utf8'), /Port 40001/);

  await provisionModal(modal, { sdk });
  assert.equal(sdk.created.length, 1, 'a running sandbox is reused');

  sdk.running.delete('sb-1');
  writeFileSync(modal.knownHosts, 'old');
  const again = await provisionModal(modal, { sdk });
  assert.equal(again.sandboxId, 'sb-2');
  assert.equal(existsSync(modal.knownHosts), false, 'a new sandbox gets fresh host keys');

  const ssh = modalSshSettings(modal);
  assert.equal(ssh.host, 'oasis-modal');
  assert.equal(ssh.configFile, modal.configFile);
  assert.match(ssh.display, /sb-2/);
});

test('ensureModalSync skips the child process while the state is fresh', () => {
  const root = tmp();
  const modal = normalizeModalSettings({}, ENV, root, tmp());
  let calls = 0;
  const run = () => { calls += 1; return { status: 1, stderr: 'boom\nModal auth failed' }; };
  assert.deepEqual(ensureModalSync(modal, { run }), { ok: false, reason: 'Modal auth failed' });
  mkdirSync(modal.stateDir, { recursive: true });
  writeFileSync(modal.stateFile, JSON.stringify({ sandboxId: 'sb-1', checkedAt: 1000 }));
  writeFileSync(modal.configFile, 'Host oasis-modal\n');
  assert.equal(ensureModalSync(modal, { run, now: 2000 }).ok, true);
  assert.equal(calls, 1);
  ensureModalSync(modal, { run, now: 1000 + 10 * 60000 });
  assert.equal(calls, 2);
});

test('oasis modal status and stop', async () => {
  const root = tmp();
  const modal = normalizeModalSettings({}, ENV, root, tmp());
  const sdk = fakeSdk();
  assert.match(await modalCommand('status', modal, { sdk }), /no Modal sandbox yet/);
  assert.match(await modalCommand('up', modal, { sdk }), /sb-1 is running/);
  assert.match(await modalCommand('status', modal, { sdk }), /sb-1: running/);
  assert.match(await modalCommand('stop', modal, { sdk }), /Stopped Modal sandbox sb-1/);
  assert.deepEqual(sdk.terminated, ['sb-1']);
  assert.deepEqual(readModalState(modal), {});
  await assert.rejects(() => modalCommand('up', { ...modal }, { sdk: { ModalClient: class { close() {} } } }));
});

test('the sandbox resolver reports missing Modal credentials', () => {
  const saved = { id: process.env.MODAL_TOKEN_ID, secret: process.env.MODAL_TOKEN_SECRET, home: process.env.HOME, cfg: process.env.MODAL_CONFIG_PATH };
  delete process.env.MODAL_TOKEN_ID; delete process.env.MODAL_TOKEN_SECRET;
  process.env.MODAL_CONFIG_PATH = path.join(tmp(), 'none.toml');
  try {
    const result = resolveSandbox({ sandbox: { enabled: true, backend: 'modal' } }, tmp(), true);
    assert.equal(result.available, false);
    assert.match(JSON.stringify(result), /MODAL_TOKEN_ID/);
  } finally {
    if (saved.id) process.env.MODAL_TOKEN_ID = saved.id;
    if (saved.secret) process.env.MODAL_TOKEN_SECRET = saved.secret;
    if (saved.cfg) process.env.MODAL_CONFIG_PATH = saved.cfg; else delete process.env.MODAL_CONFIG_PATH;
  }
});
