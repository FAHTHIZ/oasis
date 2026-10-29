import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
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

test('/mode accepts aliases but stores canonical mode semantics', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-alias-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-home-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
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

test('CLI --permission-mode accepts aliases and rejects unknown values', async (t) => {
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-cli-home-'));
  t.after(async () => { const { rm } = await import('node:fs/promises'); await rm(home, { recursive: true, force: true }); });
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, [cli, ...args], {
      env: { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis') },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.on('close', (code) => resolve({ code, output }));
  });
  for (const alias of ['manual', 'accept-edits']) {
    const result = await run(['--permission-mode', alias, '--help']);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Usage:/);
    assert.doesNotMatch(result.output, /--permission-mode must be one of/);
  }
  const invalid = await run(['--permission-mode', 'unsafe-mode', '--help']);
  assert.notEqual(invalid.code, 0);
  assert.match(invalid.output, /aliases: manual, accept-edits/);
});

test('/help documents the permission-mode aliases', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-help-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-help-home-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis') };
  const session = {
    root,
    config: { model: 'fixture-model', protocol: 'openai-compatible' },
    messages: [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hello' }],
    settings: { permissions: {} },
    permissions: new PermissionPolicy({ permissions: {} }),
    hooks: {}
  };
  const help = await runBuiltinCommand('help', '', { root, session, env, sessionOptions: {} });
  assert.match(help.output, /aliases: manual, accept-edits/);
});

test('layered settings normalize defaultMode aliases in user settings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-settings-root-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-mode-settings-home-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, '.config', 'oasis') };
  const configDir = env.OASIS_CONFIG_DIR;
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, 'settings.json'), JSON.stringify({
    permissions: { defaultMode: 'accept-edits' }
  }));
  const settings = await loadSettings(root, { env });
  assert.equal(settings.permissions.defaultMode, 'acceptEdits');
});
