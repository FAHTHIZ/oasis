import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { applyTheme, resolveTheme, currentTheme, watchThemes } from '../src/themes.mjs';

test('editing the active custom theme file re-applies it', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-theme-'));
  const env = { HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const dir = path.join(home, '.claude', 'themes');
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, 'mine.json');
  await writeFile(file, JSON.stringify({ name: 'Mine', base: 'dark', overrides: { error: '#ff0000' } }));
  applyTheme(resolveTheme('custom:mine', { env }));
  const before = currentTheme().colors.error.fg;
  const reloaded = new Promise((resolve) => {
    const stop = watchThemes({ env, debounceMs: 20, onReload: (theme) => { stop(); resolve(theme); } });
    t.after(stop);
  });
  await writeFile(file, JSON.stringify({ name: 'Mine v2', base: 'dark', overrides: { error: '#00ff00' } }));
  const theme = await Promise.race([reloaded, new Promise((_, reject) => setTimeout(() => reject(new Error('no reload')), 4000))]);
  assert.equal(theme.name, 'Mine v2');
  assert.notEqual(currentTheme().colors.error.fg, before);
  applyTheme(resolveTheme('dark', { env: {} }));
});
