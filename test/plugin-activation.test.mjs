import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { loadEnabledPlugins, pluginDependencyIds } from '../src/claude-plugins.mjs';

async function put(file, text) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); }

test('pluginDependencyIds resolves bare names against the plugin marketplace', () => {
  assert.deepEqual(pluginDependencyIds({ dependencies: ['core', 'x@other', { name: 'y', marketplace: 'm2' }, { name: 'z' }] }, 'app@market'), ['core@market', 'x@other', 'y@m2', 'z@market']);
});

test('defaultEnabled and dependencies decide which installed plugins load', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-pa-'));
  t.after(() => rm(home, { recursive: true, force: true }));
  const root = path.join(home, 'project');
  await mkdir(root);
  const plugin = async (name, manifest) => { const dir = path.join(home, 'plugins', name); await put(path.join(dir, '.claude-plugin', 'plugin.json'), JSON.stringify({ name, ...manifest })); return dir; };
  const registry = {
    'app@m': [{ scope: 'user', installPath: await plugin('app', { dependencies: ['core'] }) }],
    'core@m': [{ scope: 'user', installPath: await plugin('core', { defaultEnabled: false }) }],
    'extra@m': [{ scope: 'user', installPath: await plugin('extra', { defaultEnabled: false }) }],
    'plain@m': [{ scope: 'user', installPath: await plugin('plain', {}) }]
  };
  await put(path.join(home, '.claude', 'plugins', 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: registry }));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const names = async () => (await loadEnabledPlugins(root, { env })).map((p) => p.name).sort();
  assert.deepEqual(await names(), ['app', 'core', 'plain'], 'core is pulled in by app; extra stays off by default');
  await put(path.join(home, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { 'extra@m': true, 'plain@m': false } }));
  assert.deepEqual(await names(), ['app', 'core', 'extra']);
});
