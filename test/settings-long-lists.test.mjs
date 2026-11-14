// Long deny lists are read in full (a silent 200/500 cap let the extra rules
// through), and adding a rule or trusting a folder keeps every entry already
// in the file.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadSettings, addPermissionRule, setWorkspaceTrust } from '../src/settings.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-long-lists-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const root = path.join(dir, 'ws');
  const config = path.join(dir, 'config');
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await mkdir(config, { recursive: true });
  const env = { OASIS_CONFIG_DIR: config, HOME: dir, OASIS_TRUST_WORKSPACE: '1' };
  return { root, config, env };
}

test('every deny rule, denied domain and denyRead path is loaded', async (t) => {
  const { root, config, env } = await fixture(t);
  const deny = Array.from({ length: 700 }, (_, i) => 'run_command(tool' + i + ':*)');
  const domains = Array.from({ length: 700 }, (_, i) => 'd' + i + '.example');
  const denyRead = Array.from({ length: 300 }, (_, i) => '/secret/p' + i);
  const hardDeny = Array.from({ length: 250 }, (_, i) => 'never do thing ' + i);
  const skillOverrides = Object.fromEntries(Array.from({ length: 600 }, (_, i) => ['skill' + i, 'off']));
  await writeFile(path.join(config, 'settings.json'), JSON.stringify({ permissions: { deny }, skillOverrides, autoMode: { hard_deny: hardDeny }, sandbox: { network: { deniedDomains: domains }, filesystem: { denyRead } } }));
  const settings = await loadSettings(root, { env, skipPlugins: true });
  assert.ok(settings.permissions.deny.includes('run_command(tool699:*)'));
  assert.ok(settings.sandbox.deniedDomains.includes('d699.example'));
  assert.ok(settings.sandbox.denyRead.some((p) => p.endsWith('p299')));
  assert.equal(settings.skillOverrides.skill599, 'off');
  assert.ok(settings.autoMode.hard_deny.includes('never do thing 249'));
});

test('adding a rule keeps the existing ones past 500 and odd entries', async (t) => {
  const { root, config, env } = await fixture(t);
  const file = path.join(config, 'settings.json');
  const allow = [...Array.from({ length: 600 }, (_, i) => 'read_file(p' + i + ')'), { note: 'kept' }];
  await writeFile(file, JSON.stringify({ permissions: { allow }, trustedWorkspaces: Array.from({ length: 600 }, (_, i) => '/w' + i) }));
  await addPermissionRule('user', 'allow', 'read_file(new)', root, env);
  let saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.permissions.allow.length, 602);
  assert.deepEqual(saved.permissions.allow[600], { note: 'kept' });
  assert.equal(saved.permissions.allow.at(-1), 'read_file(new)');
  await addPermissionRule('user', 'allow', 'read_file(new)', root, env);
  saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.permissions.allow.length, 602);
  await setWorkspaceTrust(root, true, env);
  saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.trustedWorkspaces.length, 601);
  assert.equal(saved.trustedWorkspaces[599], '/w599');
});

test('a hook in the 51st group of an event still runs', async () => {
  const { normalizeHooks } = await import('../src/settings.mjs');
  const groups = Array.from({ length: 60 }, (_, i) => ({ matcher: 'm' + i, hooks: [{ type: 'command', command: 'echo ' + i }] }));
  const hooks = normalizeHooks({ PreToolUse: groups });
  assert.equal(hooks.PreToolUse.length, 60);
  assert.equal(hooks.PreToolUse[59].matcher, 'm59');
});
