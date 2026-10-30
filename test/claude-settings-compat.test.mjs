import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { loadSettings, setWorkspaceTrust, addPermissionRule, updateUserSettings, userSettingsPath } from '../src/settings.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-claude-settings-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const root = path.join(base, 'project');
  await mkdir(path.join(home, '.claude'), { recursive: true });
  await mkdir(path.join(home, 'oasis'), { recursive: true });
  await mkdir(path.join(root, '.claude'), { recursive: true });
  const managed = path.join(base, 'managed-settings.json');
  const env = { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_CONFIG_DIR: path.join(home, 'oasis'), OASIS_MANAGED_SETTINGS: managed, OASIS_PLUGIN_DIRS: '', OASIS_PLUGINS: '' };
  return { base, home, root, env, managed };
}

test('~/.claude/settings.json loads as user settings; Oasis user settings win', async (t) => {
  const { root, env } = await fixture(t);
  await writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'), JSON.stringify({ model: 'claude-model', permissions: { allow: ['Bash(npm test)'] }, env: { FROM_CLAUDE: '1', SHARED: 'claude' }, statusLine: { type: 'command', command: 'echo hi' } }));
  await writeFile(path.join(env.OASIS_CONFIG_DIR, 'settings.json'), JSON.stringify({ model: 'oasis-model', env: { SHARED: 'oasis', NUM: 3, 'BAD KEY': 'x' } }));
  const settings = await loadSettings(root, { env, skipPlugins: true });
  assert.equal(settings.model, 'oasis-model');
  assert.ok(settings.permissions.allow.includes('Bash(npm test)'));
  assert.deepEqual(settings.env, { FROM_CLAUDE: '1', SHARED: 'oasis', NUM: '3' });
  assert.equal(settings.statusLine.command, 'echo hi');
  assert.equal(settings.sources[0].file, path.join(env.CLAUDE_CONFIG_DIR, 'settings.json'));
  const ignored = await loadSettings(root, { env: { ...env, OASIS_IGNORE_CLAUDE_SETTINGS: '1' }, skipPlugins: true });
  assert.ok(!ignored.permissions.allow.includes('Bash(npm test)'));
});

test('settings loader bounds reads and rejects symlink settings files', async (t) => {
  const { root, base, env } = await fixture(t);
  const file = path.join(root, '.claude', 'settings.json');
  await writeFile(file, ' '.repeat(256 * 1024 + 1));
  await assert.rejects(loadSettings(root, { env, skipPlugins: true }), /Settings file is too large/);

  if (process.platform === 'win32') return;
  const outside = path.join(base, 'outside-settings.json');
  await writeFile(outside, JSON.stringify({ permissions: { allow: ['Bash(echo:*)'] } }));
  await rm(file);
  await symlink(outside, file);
  await assert.rejects(loadSettings(root, { env, skipPlugins: true }), /regular, non-symlink file/);
});

test('concurrent user-settings mutations preserve changes and keep the file private', async (t) => {
  const { root, env } = await fixture(t);
  const file = userSettingsPath(env);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify({ existing: true }), { mode: 0o644 });

  const operations = [
    ...Array.from({ length: 12 }, (_, index) =>
      addPermissionRule('user', 'allow', 'run_command(test-' + index + ')', root, env)
    ),
    ...Array.from({ length: 12 }, (_, index) =>
      updateUserSettings((settings) => {
        settings.concurrentFlags = { ...(settings.concurrentFlags || {}), ['flag' + index]: true };
        return settings;
      }, env)
    )
  ];
  await Promise.all(operations);

  const saved = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(saved.existing, true);
  assert.equal(saved.permissions.allow.length, 12, 'all concurrent permission-rule additions must survive');
  assert.equal(Object.keys(saved.concurrentFlags).length, 12, 'all concurrent settings mutations must survive');
  if (process.platform !== 'win32') {
    assert.equal((await (await import('node:fs/promises')).stat(file)).mode & 0o777, 0o600,
      'a user settings file containing environment values must not stay group/world-readable');
  }
});

test('sandbox credential masking defaults on and project opt-out requires trust', async (t) => {
  const { root, env } = await fixture(t);
  let settings = await loadSettings(root, { env, skipPlugins: true });
  assert.equal(settings.sandbox.maskSensitivePaths, true, 'credential masking defaults on');

  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { enabled: true, maskSensitivePaths: false } }));
  settings = await loadSettings(root, { env, skipPlugins: true });
  assert.equal(settings.sandbox.enabled, false, 'untrusted projects cannot enable or loosen sandbox options');
  assert.equal(settings.sandbox.maskSensitivePaths, true, 'an untrusted project cannot disable credential masking');
  assert.ok(settings.ignoredUntrusted.some((file) => file.endsWith(path.join('.claude', 'settings.json'))));

  await setWorkspaceTrust(root, true, env);
  settings = await loadSettings(root, { env, skipPlugins: true });
  assert.equal(settings.sandbox.enabled, true);
  assert.equal(settings.sandbox.maskSensitivePaths, false, 'trusted opt-out is preserved');
});

test('project env needs trust; managed settings load last and can disable bypass mode', async (t) => {
  const { root, env, managed } = await fixture(t);
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ env: { NODE_OPTIONS: '--require ./evil.js' }, permissions: { defaultMode: 'bypassPermissions' } }));
  let settings = await loadSettings(root, { env, skipPlugins: true });
  assert.equal(settings.env, undefined, 'an untrusted project cannot set environment variables');
  assert.ok(settings.ignoredUntrusted.length);
  await setWorkspaceTrust(root, true, env);
  settings = await loadSettings(root, { env, skipPlugins: true });
  assert.equal(settings.env.NODE_OPTIONS, '--require ./evil.js');
  assert.equal(settings.permissions.defaultMode, 'bypassPermissions');
  await writeFile(managed, JSON.stringify({ permissions: { deny: ['Bash(curl:*)'], disableBypassPermissionsMode: 'disable' }, model: 'managed-model' }));
  settings = await loadSettings(root, { env, skipPlugins: true });
  assert.equal(settings.model, 'managed-model');
  assert.ok(settings.permissions.deny.includes('Bash(curl:*)'));
  assert.equal(settings.permissions.disableBypassPermissionsMode, true);
  assert.equal(settings.permissions.defaultMode, 'default', 'bypass default mode is dropped when disabled');
  assert.equal(settings.sources.at(-1).scope, 'managed');
  const blocked = await runBuiltinCommand('mode', 'bypassPermissions', { root, env, session: null, sessionOptions: { disableBypass: true } });
  assert.match(blocked.output, /disabled by settings/);
});

test('memory walks up to parent CLAUDE.md files and loads .claude/rules', async (t) => {
  const { loadMemory, nestedMemoryFor } = await import('../src/memory.mjs');
  const { base, env } = await fixture(t);
  const mono = path.join(base, 'mono');
  const pkg = path.join(mono, 'packages', 'web');
  await mkdir(path.join(pkg, '.claude', 'rules', 'frontend'), { recursive: true });
  await writeFile(path.join(mono, 'CLAUDE.md'), 'Monorepo rule: use pnpm.');
  await writeFile(path.join(mono, 'packages', 'CLAUDE.local.md'), 'Packages note.');
  await writeFile(path.join(pkg, 'CLAUDE.md'), 'Web package rule.');
  await writeFile(path.join(pkg, '.claude', 'rules', 'testing.md'), 'Always run vitest.');
  await writeFile(path.join(pkg, '.claude', 'rules', 'frontend', 'react.md'), '---\npaths:\n  - "src/**/*.tsx"\n  - src/**/*.jsx\n---\nUse function components.');
  await mkdir(path.join(env.CLAUDE_CONFIG_DIR, 'rules'), { recursive: true });
  await writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'rules', 'style.md'), 'Personal style rule.');
  await writeFile(path.join(env.CLAUDE_CONFIG_DIR, 'CLAUDE.md'), 'User-level memory.');
  const memory = await loadMemory(pkg, { env, home: env.HOME });
  assert.match(memory, /User-level memory/);
  const order = ['Monorepo rule', 'Packages note', 'Web package rule'].map((text) => memory.indexOf(text));
  assert.ok(order.every((index) => index >= 0) && order[0] < order[1] && order[1] < order[2], 'parents load root-most first, workspace last');
  assert.match(memory, /Project rule: testing\.md ---\nAlways run vitest/);
  assert.doesNotMatch(memory, /frontend\/react\.md/, 'path-scoped rules stay out of base project memory');
  const scopedMatch = await nestedMemoryFor(pkg, 'src/App.tsx', new Set(), { env, home: env.HOME });
  assert.ok(scopedMatch.some((rule) => /Use function components\./.test(rule.text)), 'a matching path loads its rule');
  const scopedMiss = await nestedMemoryFor(pkg, 'README.md', new Set(), { env, home: env.HOME });
  assert.ok(!scopedMiss.some((rule) => /Use function components\./.test(rule.text)), 'a non-matching path does not load the rule');
  assert.match(memory, /User rule: style\.md/);
  const none = await loadMemory(pkg, { env: { ...env, OASIS_DISABLE_PARENT_MEMORY: '1' }, home: env.HOME });
  assert.ok(!/Monorepo rule/.test(none));
});
