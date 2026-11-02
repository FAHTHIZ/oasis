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

test('existing package caches are writable in the sandbox, home and credentials are not', async () => {
  const { mkdtemp, mkdir, symlink } = await import('node:fs/promises');
  const os = (await import('node:os')).default;
  const path = (await import('node:path')).default;
  const { collectCacheDirectories } = await import('../src/sandbox.mjs');
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-cache-home-'));
  await mkdir(path.join(home, '.npm'), { recursive: true });
  await mkdir(path.join(home, '.cargo', 'registry'), { recursive: true });
  await mkdir(path.join(home, '.ssh'), { recursive: true });
  const outside = await mkdtemp(path.join(os.tmpdir(), 'oasis-cache-out-'));
  await mkdir(path.join(home, '.cache'), { recursive: true });
  await symlink(outside, path.join(home, '.cache', 'pip'));
  const found = collectCacheDirectories({ HOME: home });
  const { realpathSync } = await import('node:fs');
  const real = realpathSync(home);
  assert.deepEqual(found.sort(), [path.join(real, '.cargo', 'registry'), path.join(real, '.npm')].sort());
  assert.ok(!found.includes(real));
});

test('cache directories are found when the home path is a symlink (macOS /var -> /private/var)', async () => {
  const { mkdtemp, mkdir, symlink } = await import('node:fs/promises');
  const { collectCacheDirectories } = await import('../src/sandbox.mjs');
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-cache-link-'));
  await mkdir(path.join(base, 'real', '.npm'), { recursive: true });
  await symlink(path.join(base, 'real'), path.join(base, 'link'));
  assert.deepEqual(collectCacheDirectories({ HOME: path.join(base, 'link') }), [path.join(realpathSync(base), 'real', '.npm')]);
});
