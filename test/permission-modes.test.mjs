import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizePermissionMode } from '../src/permission-modes.mjs';
import { PermissionPolicy } from '../src/permissions.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { loadSettings } from '../src/settings.mjs';

test('permission aliases map only to existing canonical modes', () => {
  assert.equal(normalizePermissionMode('manual'), 'default');
  assert.equal(normalizePermissionMode('default'), 'default');
  assert.equal(normalizePermissionMode('accept-edits'), 'acceptEdits');
  assert.equal(normalizePermissionMode('accept_edits'), 'acceptEdits');
  assert.equal(normalizePermissionMode('acceptEdits'), 'acceptEdits');
  assert.equal(normalizePermissionMode('plan'), 'plan');
  assert.equal(normalizePermissionMode('auto'), 'auto');
  assert.equal(normalizePermissionMode('bypassPermissions'), 'bypassPermissions');
  assert.equal(normalizePermissionMode('bypass'), null);
  assert.equal(normalizePermissionMode(''), null);
  assert.equal(normalizePermissionMode(null), null);
});

test('PermissionPolicy normalizes aliases on construction and setMode', () => {
  assert.equal(new PermissionPolicy({ permissions: { defaultMode: 'manual' } }).mode, 'default');
  const policy = new PermissionPolicy({ permissions: {} });
  policy.setMode('accept-edits');
  assert.equal(policy.mode, 'acceptEdits');
  assert.throws(() => policy.setMode('unsafe-mode'), /Unknown permission mode/);
});

test('/mode accepts aliases but stores canonical mode semantics', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-alias-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-home-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis') };
  const session = {
    root,
    config: { model: 'fixture-model', protocol: 'openai-compatible' },
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
    settings: { permissions: {} },
    permissions: new PermissionPolicy({ permissions: {} }),
    hooks: {}
  };
  const state = { root, session, env, sessionOptions: {} };
  const manual = await runBuiltinCommand('mode', 'manual', state);
  assert.match(manual.output, /set to default \(alias for default\)/);
  assert.equal(session.permissions.mode, 'default');
  assert.equal(state.sessionOptions.permissionMode, 'default');

  const edits = await runBuiltinCommand('mode', 'accept-edits', state);
  assert.match(edits.output, /set to acceptEdits \(alias for acceptEdits\)/);
  assert.equal(session.permissions.mode, 'acceptEdits');
  assert.equal(state.sessionOptions.permissionMode, 'acceptEdits');

  const unknown = await runBuiltinCommand('mode', 'unsafe-mode', state);
  assert.match(unknown.output, /Unknown mode/);
  assert.equal(session.permissions.mode, 'acceptEdits');
});

test('layered settings normalize defaultMode aliases in user settings', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-settings-root-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-settings-home-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis') };
  const configDir = env.OASIS_CONFIG_DIR;
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
    permissions: { defaultMode: 'accept-edits' }
  }));
  const settings = await loadSettings(root, { env });
  assert.equal(settings.permissions.defaultMode, 'acceptEdits');
});
