import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { containerArgs, detectOciRuntime } from '../src/sandbox.mjs';
import { loadSettings, userSettingsPath } from '../src/settings.mjs';

const box = { kind: 'docker', enabled: true, available: true, network: false, writable: ['/tmp/workspace'], maskedPaths: [], protectedRoots: [] };

test('sandbox.runtime adds --runtime to docker and podman runs', () => {
  const args = containerArgs('sh', ['-c', 'true'], { ...box, runtime: 'runsc' }, '/tmp/workspace', 'linux');
  assert.deepEqual(args.slice(0, 3), ['run', '--runtime', 'runsc']);
  assert.ok(args.includes('--cap-drop'));
  assert.ok(!containerArgs('sh', [], box, '/tmp/workspace', 'linux').includes('--runtime'));
  const podman = containerArgs('sh', [], { ...box, kind: 'podman', runtime: '/usr/local/bin/runsc' }, '/tmp/workspace', 'linux');
  assert.equal(podman[podman.indexOf('--runtime') + 1], '/usr/local/bin/runsc');
});

test('a docker runtime that is not registered makes the sandbox unavailable with a gVisor fix', () => {
  const registered = detectOciRuntime('docker', 'runsc', true, () => ({ status: 0, stdout: '{"runc":{"path":"runc"},"runsc":{"path":"/usr/local/bin/runsc"}}' }));
  assert.equal(registered.available, true);
  assert.equal(registered.isolation, 'gvisor');
  const missing = detectOciRuntime('docker', 'runsc', true, () => ({ status: 0, stdout: '{"runc":{"path":"runc"}}' }));
  assert.equal(missing.available, false);
  assert.match(missing.reason, /no runtime named runsc \(it has runc\)/);
  assert.match(missing.reason, /gvisor\.dev.*runsc install/);
  const failed = detectOciRuntime('docker', 'kata-runtime', true, () => ({ status: 1, stdout: '' }));
  assert.equal(failed.available, false);
  const podmanPath = detectOciRuntime('podman', '/opt/runsc', true, () => ({ status: 0, stdout: 'runsc version' }));
  assert.equal(podmanPath.available, true);
  const podmanMissing = detectOciRuntime('podman', '/opt/nope', true, () => { throw new Error('ENOENT'); });
  assert.equal(podmanMissing.available, false);
});

async function setup(t, user, project) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-rt-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-rt-root-'));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  const env = { HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_IGNORE_CLAUDE_SETTINGS: '1' };
  await mkdir(path.dirname(userSettingsPath(env)), { recursive: true });
  // Trusted, so the repository's sandbox block is read at all.
  await writeFile(userSettingsPath(env), JSON.stringify({ ...user, trustedWorkspaces: [root] }));
  if (project) { await mkdir(path.join(root, '.oasis'), { recursive: true }); await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify(project)); }
  return { env, root };
}

test('runtime comes only from your own settings; a repository can tighten readOnlyRoot but not loosen it', async (t) => {
  const { env, root } = await setup(t, { sandbox: { runtime: 'runsc', readOnlyRoot: true } }, { sandbox: { runtime: 'runc', readOnlyRoot: false } });
  const settings = await loadSettings(root, { env });
  assert.equal(settings.sandbox.runtime, 'runsc');
  assert.equal(settings.sandbox.readOnlyRoot, true);
  const other = await setup(t, {}, { sandbox: { runtime: 'runc', readOnlyRoot: true } });
  const repoOnly = await loadSettings(other.root, { env: other.env });
  assert.equal(repoOnly.sandbox.runtime, undefined);
  assert.equal(repoOnly.sandbox.readOnlyRoot, true);
  const fromEnv = await loadSettings(other.root, { env: { ...other.env, OASIS_SANDBOX_RUNTIME: 'runsc' } });
  assert.equal(fromEnv.sandbox.runtime, 'runsc');
  const bad = await loadSettings(other.root, { env: { ...other.env, OASIS_SANDBOX_RUNTIME: 'runsc; rm -rf /' } });
  assert.equal(bad.sandbox.runtime, undefined);
});
