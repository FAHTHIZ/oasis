import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { loadSettings, setWorkspaceTrust } from '../src/settings.mjs';
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
  const { loadMemory } = await import('../src/memory.mjs');
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
  assert.match(memory, /Project rule: frontend\/react\.md \(applies when working on files matching src\/\*\*\/\*\.tsx, src\/\*\*\/\*\.jsx\) ---\nUse function components\./);
  assert.match(memory, /User rule: style\.md/);
  const none = await loadMemory(pkg, { env: { ...env, OASIS_DISABLE_PARENT_MEMORY: '1' }, home: env.HOME });
  assert.ok(!/Monorepo rule/.test(none));
});
