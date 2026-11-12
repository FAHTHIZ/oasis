import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { loadSettings } from '../src/settings.mjs';
import { resolveSandbox, wrapCommand, macProfile, detectSandbox } from '../src/sandbox.mjs';
import { executeTool } from '../src/tools.mjs';

async function tmp(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oasis-cred-')));
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

test('sandbox.credentials merges deny entries from every scope; mask is deny from trusted scopes and ignored from repositories', async (t) => {
  const s = await setup(t, {
    user: { sandbox: { credentials: { files: [{ path: '~/.aws/credentials', mode: 'deny' }, { path: '~/.config/gh/hosts.yml', mode: 'mask', injectHosts: ['api.github.com'] }], envVars: [{ name: 'GITHUB_TOKEN', mode: 'mask' }] } } },
    project: { sandbox: { enabled: true, credentials: { files: [{ path: './.env', mode: 'deny' }, { path: './mask-me', mode: 'mask' }, { path: './odd', mode: 'hide' }], envVars: [{ name: 'NPM_TOKEN', mode: 'deny' }, { name: 'REPO_MASK', mode: 'mask' }, { name: 'bad-name', mode: 'deny' }] } } }
  });
  const settings = await loadSettings(s.root, { env: s.env });
  assert.deepEqual(settings.sandbox.credentialFiles, [path.join(s.home, '.aws', 'credentials'), path.join(s.home, '.config', 'gh', 'hosts.yml'), path.join(s.root, '.env')]);
  assert.deepEqual(settings.sandbox.credentialEnv, ['GITHUB_TOKEN', 'NPM_TOKEN']);
  assert.ok(settings.sandbox.credentialNotes.some((note) => /GITHUB_TOKEN: "mask" is applied as "deny"/.test(note)));
  assert.ok(settings.sandbox.credentialNotes.some((note) => /REPO_MASK: mask entries from project settings are ignored/.test(note)));
});

test('credential files are masked for every backend and allowRead cannot re-open them', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t);
  await mkdir(path.join(home, '.aws'), { recursive: true });
  await writeFile(path.join(home, '.aws', 'credentials'), 'secret');
  const sandbox = { ...resolveSandbox({ sandbox: { enabled: true, maskSensitivePaths: false, writableCaches: false, denyRead: [home], allowRead: [path.join(home, '.aws'), path.join(home, '.aws', 'credentials')], credentialFiles: [path.join(home, '.aws', 'credentials')], credentialEnv: ['GITHUB_TOKEN', 'not valid'] } }, root), available: true, kind: 'bubblewrap' };
  // The folder may be re-opened, but the credential file inside it stays masked after it.
  assert.deepEqual(sandbox.reopenedPaths.map((item) => item.path), [path.join(home, '.aws')]);
  assert.deepEqual(sandbox.deniedEnv, ['GITHUB_TOKEN']);
  assert.ok(sandbox.maskedPaths.some((item) => item.path === path.join(home, '.aws', 'credentials')));
  const bwrap = wrapCommand('true', [], sandbox, root).args.join(' ');
  assert.match(bwrap, /--unsetenv GITHUB_TOKEN/);
  const credential = path.join(home, '.aws', 'credentials');
  assert.ok(bwrap.lastIndexOf('--ro-bind /dev/null ' + credential) > bwrap.indexOf('--ro-bind ' + path.join(home, '.aws') + ' '), 're-masked after the re-open');
  const mac = wrapCommand('true', [], { ...sandbox, kind: 'sandbox-exec' }, root);
  assert.equal(mac.command, 'sandbox-exec');
  assert.deepEqual(mac.args.slice(2, 6), ['/usr/bin/env', '-u', 'GITHUB_TOKEN', 'true']);
  assert.match(macProfile(sandbox), /\(deny file-read\* \(subpath "[^"]+"\)\)/);
});

test('allowManagedReadPathsOnly keeps only managed allowRead entries; denyRead still merges', async (t) => {
  const s = await setup(t, {
    user: { sandbox: { filesystem: { denyRead: ['~/private'], allowRead: ['~/mine'] } } },
    managed: { sandbox: { enabled: true, filesystem: { denyRead: ['~/'], allowRead: ['~/work'], allowManagedReadPathsOnly: true } } }
  });
  for (const dir of ['work', 'mine', 'private']) await mkdir(path.join(s.home, dir), { recursive: true });
  const settings = await loadSettings(s.root, { env: s.env });
  assert.equal(settings.sandbox.allowManagedReadPathsOnly, true);
  assert.deepEqual(settings.sandbox.managedAllowRead, [path.join(s.home, 'work')]);
  const sandbox = resolveSandbox(settings, s.root);
  assert.deepEqual(sandbox.reopenedPaths.map((item) => item.path), [path.join(s.home, 'work')]);
  assert.ok(sandbox.maskedPaths.some((item) => item.path === path.join(s.home, 'private')));
  const open = resolveSandbox({ ...settings, sandbox: { ...settings.sandbox, allowManagedReadPathsOnly: false } }, s.root);
  assert.deepEqual(open.reopenedPaths.map((item) => item.path).sort(), [path.join(s.home, 'mine'), path.join(s.home, 'work')].sort());
});

const bwrapReady = process.platform === 'linux' && detectSandbox(true).available && detectSandbox(true).kind === 'bubblewrap';

test('bubblewrap: a sandboxed run_shell cannot read a denied credential file or see a denied variable', { skip: !bwrapReady }, async (t) => {
  const root = await tmp(t);
  const vault = path.join(root, 'vault');
  await mkdir(vault);
  await writeFile(path.join(vault, 'credentials'), 'aws-secret');
  await writeFile(path.join(vault, 'notes.txt'), 'plain');
  const sandbox = resolveSandbox({ sandbox: { enabled: true, maskSensitivePaths: false, writableCaches: false, credentialFiles: [path.join(vault, 'credentials')], credentialEnv: ['OASIS_TEST_TOKEN'] } }, root, true);
  const env = { ...process.env, OASIS_TEST_TOKEN: 'tok-123', OASIS_TEST_OTHER: 'kept' };
  const wrapped = wrapCommand('/bin/sh', ['-c', 'echo "${OASIS_TEST_TOKEN:-unset} ${OASIS_TEST_OTHER:-unset}"; cat ' + path.join(vault, 'credentials') + '; cat ' + path.join(vault, 'notes.txt')], sandbox, root);
  const out = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', env }).stdout;
  assert.equal(out, 'unset kept\nplain');
  const result = await executeTool('run_shell', { command: 'echo ${OASIS_TEST_TOKEN:-unset}; cat ' + path.join(vault, 'credentials') }, { root, sandbox, approval: async () => true, env });
  assert.doesNotMatch(JSON.stringify(result), /tok-123|aws-secret/);
  assert.match(String(result.stdout || result.output || JSON.stringify(result)), /unset/);
});
