import test from 'node:test';
import assert from 'node:assert/strict';
import { containerArgs, containerPath, detectContainerRuntime, wrapCommand, resolveSandbox, DEFAULT_CONTAINER_IMAGE } from '../src/sandbox.mjs';
import { loadSettings } from '../src/settings.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const box = (extra = {}) => ({ enabled: true, available: true, kind: 'docker', network: false, writable: ['/work/app'], image: 'node:22-bookworm', ...extra });

test('docker backend mounts only the workspace, drops capabilities and blocks network by default', () => {
  const launch = wrapCommand('npm', ['test'], box(), '/work/app');
  assert.equal(launch.command, 'docker');
  const a = launch.args;
  assert.deepEqual(a.slice(0, 4), ['run', '--rm', '-i', '--init']);
  assert.equal(a[a.indexOf('--network') + 1], 'none');
  assert.equal(a[a.indexOf('--cap-drop') + 1], 'ALL');
  assert.ok(a.includes('no-new-privileges'));
  assert.deepEqual(a.filter((x, i) => a[i - 1] === '--volume'), ['/work/app:/work/app:rw']);
  assert.equal(a[a.indexOf('--workdir') + 1], '/work/app');
  assert.deepEqual(a.slice(-3), ['node:22-bookworm', 'npm', 'test']);
});

test('container credential masks overlay only paths inside writable roots', () => {
  const masks = [
    { path: '/home/example/.ssh', type: 'directory' },
    { path: '/home/example/.netrc', type: 'file' },
    { path: '/home/example-outside/.aws', type: 'directory' },
    { path: '/home/example', type: 'directory' }
  ];
  const a = containerArgs('cat', ['/home/example/.netrc'], box({
    writable: ['/home/example'],
    protectedRoots: ['/home/example'],
    maskedPaths: masks
  }), '/home/example', 'linux');
  const volumes = [];
  const tmpfs = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--volume') volumes.push({ index: i, value: a[i + 1] });
    if (a[i] === '--tmpfs') tmpfs.push({ index: i, value: a[i + 1] });
  }
  assert.ok(volumes.some((item) => item.value === '/home/example:/home/example:rw'));
  assert.ok(volumes.some((item) => item.value === '/dev/null:/home/example/.netrc:ro'), 'file masks must use a read-only null-device bind');
  assert.deepEqual(tmpfs.map((item) => item.value), [
    '/home/example/.ssh:rw,nosuid,nodev,noexec,size=1m'
  ], 'directory masks inside the workspace use an ephemeral tmpfs');
  assert.ok(!a.some((value) => String(value).includes('home/example-outside')), 'secrets outside mounted roots are already absent');
  const lastHostMount = Math.max(...volumes.map((item) => item.index));
  assert.ok(tmpfs.every((item) => item.index > lastHostMount), 'directory masks must overlay host mounts');
  assert.ok(volumes.find((item) => item.value.startsWith('/dev/null:')).index > lastHostMount, 'file masks must overlay host mounts');
  assert.equal(a[a.indexOf('--workdir') + 1], '/home/example');
});
test('container network, limits and podman user namespace options', () => {
  const a = containerArgs('ls', [], box({ kind: 'podman', network: true, memory: '2g', cpus: '1.5' }), '/work/app', 'linux');
  assert.equal(a[a.indexOf('--network') + 1], 'bridge');
  assert.equal(a[a.indexOf('--memory') + 1], '2g');
  assert.equal(a[a.indexOf('--cpus') + 1], '1.5');
  assert.equal(a[a.indexOf('--userns') + 1], 'keep-id');
  assert.throws(() => containerArgs('ls', [], box({ image: 'bad image; rm' }), '/work/app'), /not valid/);
});

test('windows drive paths map under /host so Docker Desktop gives Windows real isolation', () => {
  assert.equal(containerPath('C:\\Users\\me\\proj', 'win32'), '/host/c/Users/me/proj');
  const a = containerArgs('node', ['-v'], box({ writable: ['C:\\Users\\me\\proj'] }), 'C:\\Users\\me\\proj', 'win32');
  assert.ok(a.includes('C:\\Users\\me\\proj:/host/c/Users/me/proj:rw'));
  assert.equal(a[a.indexOf('--workdir') + 1], '/host/c/Users/me/proj');
  assert.ok(!a.includes('--user'));
});

test('container runtime probe reports missing or stopped engines with a fix', () => {
  const missing = detectContainerRuntime('docker', true, () => { throw new Error('ENOENT'); });
  assert.equal(missing.available, false);
  assert.match(missing.reason, /not installed/);
  const stopped = detectContainerRuntime('docker', true, () => ({ status: 1, stderr: 'Cannot connect to the Docker daemon' }));
  assert.match(stopped.reason, /not responding.*Cannot connect/);
  assert.equal(detectContainerRuntime('docker', true, () => ({ status: 0 })).kind, 'docker');
  assert.match(detectContainerRuntime('lxc', true).reason, /Unknown sandbox backend/);
  detectContainerRuntime('docker', true, () => ({ status: 1 }));
});

test('settings accept backend, image and the documented writableCaches/autoAllowShellCommands keys', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-sbx-'));
  try {
    const settings = await loadSettings(dir, { env: { OASIS_CONFIG_DIR: path.join(dir, 'cfg'), OASIS_SANDBOX: '1', OASIS_SANDBOX_BACKEND: 'docker', OASIS_SANDBOX_IMAGE: 'python:3.12-slim' }, extraSettings: [{ settings: { sandbox: { writableCaches: false, autoAllowShellCommands: true, memory: '1g' } } }] });
    assert.equal(settings.sandbox.backend, 'docker');
    assert.equal(settings.sandbox.image, 'python:3.12-slim');
    assert.equal(settings.sandbox.writableCaches, false);
    assert.equal(settings.sandbox.autoAllowShellCommands, true);
    const resolved = resolveSandbox({ sandbox: { enabled: true, backend: 'docker' } }, dir);
    assert.equal(resolved.backend, 'docker');
    assert.equal(resolved.image, DEFAULT_CONTAINER_IMAGE);
    assert.deepEqual(resolved.writableCaches, []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
