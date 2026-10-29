import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { macProfile, collectSensitivePaths, wrapCommand } from '../src/sandbox.mjs';

test('macOS Seatbelt profile rejects control characters in writable paths', () => {
  const unsafePaths = [
    '/workspace\n(allow file-write* (subpath "/"))',
    '/workspace\r(allow file-write* (subpath "/"))',
    '/workspace\u0000extra',
    '/workspace\u2028(allow file-write* (subpath "/"))',
    '/workspace\u2029(allow file-write* (subpath "/"))'
  ];

  for (const writablePath of unsafePaths) {
    assert.throws(
      () => macProfile({ writable: [writablePath], maskedPaths: [], network: false }),
      /control characters/
    );
  }
});

test('macOS Seatbelt profile rejects control characters in masked paths', () => {
  assert.throws(
    () => macProfile({
      writable: ['/workspace'],
      maskedPaths: [{ path: '/home/user/.ssh\n(allow file-read*)', type: 'directory' }],
      network: false
    }),
    /control characters/
  );
});

test('credential masking remains active when the workspace is the home directory', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-sandbox-home-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ssh = path.join(home, '.ssh');
  await mkdir(ssh, { recursive: true });
  await writeFile(path.join(ssh, 'id_ed25519'), 'test secret');

  const env = { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') };
  const masked = collectSensitivePaths(env);
  const sshReal = realpathSync(ssh);
  assert.ok(masked.some((item) => item.path === sshReal), 'home workspace must not disable ~/.ssh masking');

});

test('credential masking is independent of additional writable directory grants', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-sandbox-extra-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const ssh = path.join(home, '.ssh');
  await mkdir(ssh, { recursive: true });
  await writeFile(path.join(ssh, 'id_ed25519'), 'test secret');
  const masked = collectSensitivePaths({ HOME: home });
  const sshReal = realpathSync(ssh);
  assert.ok(masked.some((item) => item.path === sshReal), 'credential roots stay masked even when the home directory is broadly writable');
});

test('bubblewrap overlays credential masks after writable mounts', () => {
  const launch = wrapCommand('echo', [], {
    enabled: true,
    available: true,
    kind: 'bubblewrap',
    writable: ['/home/example'],
    maskedPaths: [{ path: '/home/example/.ssh', type: 'directory' }],
    network: false
  }, '/home/example');

  const writableBind = launch.args.indexOf('--bind');
  const credentialMask = launch.args.lastIndexOf('--tmpfs');
  assert.ok(writableBind >= 0 && credentialMask > writableBind, 'credential masks must overlay writable workspace mounts');
});
