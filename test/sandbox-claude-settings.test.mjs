import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { loadSettings, resolveSandboxSettingPath } from '../src/settings.mjs';
import { resolveSandbox, wrapCommand, macProfile, detectSandbox } from '../src/sandbox.mjs';
import { createSession } from '../src/agent.mjs';

async function tmp(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oasis-sbx-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t, { user, project, managed } = {}) {
  const root = await tmp(t);
  const home = await tmp(t);
  if (user) await writeFile(path.join(home, 'settings.json'), JSON.stringify(user));
  if (project) { await mkdir(path.join(root, '.claude'), { recursive: true }); await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify(project)); }
  let managedFile = '';
  if (managed) { managedFile = path.join(home, 'managed.json'); await writeFile(managedFile, JSON.stringify(managed)); }
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: managedFile, OASIS_TRUST_WORKSPACE: '1' };
  return { root, home, env };
}

test('sandbox paths resolve with Claude Code prefixes', () => {
  const env = { HOME: '/home/u', CLAUDE_CONFIG_DIR: '' };
  assert.equal(resolveSandboxSettingPath('/tmp/build/', 'project', '/repo', env), '/tmp/build');
  assert.equal(resolveSandboxSettingPath('//tmp/build', 'project', '/repo', env), '/tmp/build');
  assert.equal(resolveSandboxSettingPath('~/.kube', 'project', '/repo', env), '/home/u/.kube');
  assert.equal(resolveSandboxSettingPath('./output', 'project', '/repo', env), '/repo/output');
  assert.equal(resolveSandboxSettingPath('output', 'user', '/repo', env), '/home/u/.claude/output');
  assert.equal(resolveSandboxSettingPath('~/build/**', 'user', '/repo', env), '/home/u/build');
  assert.equal(resolveSandboxSettingPath('./src/*', 'project', '/repo', env), null, 'other wildcards are skipped');
});

test('Claude Code sandbox keys load: network object, autoAllowBashIfSandboxed, filesystem lists, failIfUnavailable', async (t) => {
  const s = await setup(t, {
    user: { sandbox: { network: { allowedDomains: ['github.com'] }, filesystem: { allowWrite: ['~/.kube'] }, failIfUnavailable: false } },
    project: { sandbox: { enabled: true, autoAllowBashIfSandboxed: false, network: { allowedDomains: ['*.npmjs.org'], deniedDomains: ['evil.example'] }, filesystem: { denyWrite: ['./locked'], denyRead: ['~/.aws/credentials'] } } },
    managed: { sandbox: { failIfUnavailable: true } }
  });
  const settings = await loadSettings(s.root, { env: s.env });
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.autoAllowCommands, false);
  assert.deepEqual(settings.sandbox.allowedDomains, ['github.com', '*.npmjs.org']);
  assert.deepEqual(settings.sandbox.deniedDomains, ['evil.example']);
  assert.deepEqual(settings.sandbox.allowWrite, [path.join(s.home, '.kube')]);
  assert.deepEqual(settings.sandbox.denyWrite, [path.join(s.root, 'locked')]);
  assert.deepEqual(settings.sandbox.denyRead, [path.join(s.home, '.aws', 'credentials')]);
  assert.equal(settings.sandbox.failIfUnavailable, true);
});

test('allowManagedDomainsOnly keeps only the managed allowed domains', async (t) => {
  const s = await setup(t, { user: { sandbox: { enabled: true, network: { allowedDomains: ['user.example'] } } }, managed: { sandbox: { network: { allowedDomains: ['corp.example'], allowManagedDomainsOnly: true } } } });
  const settings = await loadSettings(s.root, { env: s.env });
  const sandbox = resolveSandbox(settings, s.root);
  if (sandbox.allowedDomains) assert.deepEqual(sandbox.allowedDomains, ['corp.example']);
  else assert.equal(sandbox.available, false);
});

test('filesystem lists reach bubblewrap, sandbox-exec and container arguments', async (t) => {
  const root = await tmp(t);
  const extra = await tmp(t);
  await mkdir(path.join(root, 'locked'));
  await writeFile(path.join(extra, 'secret.txt'), 'x');
  const settings = { sandbox: { enabled: true, maskSensitivePaths: false, writableCaches: false, allowWrite: [extra, path.join(root, 'missing')], denyWrite: [path.join(root, 'locked')], denyRead: [path.join(extra, 'secret.txt')] } };
  const sandbox = { ...resolveSandbox(settings, root), available: true, kind: 'bubblewrap' };
  assert.ok(sandbox.writable.includes(extra));
  assert.ok(!sandbox.writable.includes(path.join(root, 'missing')), 'missing paths are not mounted');
  const bwrap = wrapCommand('true', [], sandbox, root).args.join(' ');
  assert.match(bwrap, new RegExp('--bind ' + extra + ' ' + extra));
  assert.match(bwrap, new RegExp('--ro-bind ' + path.join(root, 'locked') + ' ' + path.join(root, 'locked')));
  assert.match(bwrap, new RegExp('--ro-bind /dev/null ' + path.join(extra, 'secret.txt')));
  const profile = macProfile(sandbox);
  assert.match(profile, new RegExp('\\(deny file-write\\* \\(subpath "' + path.join(root, 'locked') + '"\\)\\)'));
  assert.match(profile, /\(deny file-read\* \(literal ".*secret\.txt"\)\)/);
});

test('bubblewrap enforces denyWrite inside the workspace and allowWrite outside it', { skip: process.platform !== 'linux' || !detectSandbox(true).available }, async (t) => {
  const root = await tmp(t);
  const extra = await tmp(t);
  await mkdir(path.join(root, 'locked'));
  const sandbox = resolveSandbox({ sandbox: { enabled: true, maskSensitivePaths: false, writableCaches: false, allowWrite: [extra], denyWrite: [path.join(root, 'locked')] } }, root);
  const run = (file) => { const wrapped = wrapCommand('/bin/sh', ['-c', 'echo hi > "$1"', 'sh', file], sandbox, root); return spawnSync(wrapped.command, wrapped.args).status; };
  assert.equal(run(path.join(root, 'ok.txt')), 0);
  assert.notEqual(run(path.join(root, 'locked', 'no.txt')), 0);
  assert.equal(run(path.join(extra, 'yes.txt')), 0);
});

test('failIfUnavailable stops session start when the sandbox cannot run', async (t) => {
  const s = await setup(t, { user: { sandbox: { enabled: true, backend: 'ssh', failIfUnavailable: true, ssh: { host: 'nobody@127.0.0.1', port: 9 } } } });
  const sandbox = resolveSandbox(await loadSettings(s.root, { env: s.env }), s.root);
  if (sandbox.available) { t.skip('sandbox unexpectedly available'); return; }
  await assert.rejects(() => createSession({ root: s.root, env: s.env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'x', apiKey: '' } }), /failIfUnavailable/);
});
