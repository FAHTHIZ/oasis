import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { loadSettings, userSettingsPath } from '../src/settings.mjs';
import { unrequestedGitWrite } from '../src/git-intent.mjs';

async function setup(t, user, project) {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-keys-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-keys-root-'));
  t.after(() => Promise.all([rm(home, { recursive: true, force: true }), rm(root, { recursive: true, force: true })]));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), OASIS_IGNORE_CLAUDE_SETTINGS: '1' };
  await mkdir(path.dirname(userSettingsPath(env)), { recursive: true });
  await writeFile(userSettingsPath(env), JSON.stringify(user));
  if (project) { await mkdir(path.join(root, '.oasis'), { recursive: true }); await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify(project)); }
  return { env, root };
}

test('documented session settings survive loading', async (t) => {
  const { env, root } = await setup(t, { allowUnrequestedGitWrites: true, assistedVerification: false, textToolCalls: false, untrustedContentGuard: false });
  const settings = await loadSettings(root, { env });
  assert.equal(settings.allowUnrequestedGitWrites, true);
  assert.equal(settings.assistedVerification, false);
  assert.equal(settings.textToolCalls, false);
  assert.equal(settings.untrustedContentGuard, false);
  assert.equal(unrequestedGitWrite('fix the bug', 'run_command', { command: 'git', args: ['push'] }, { settings, env: {} }), null);
});

test('an untrusted repository cannot allow unrequested git writes but can turn off text tool calls', async (t) => {
  const { env, root } = await setup(t, {}, { allowUnrequestedGitWrites: true, textToolCalls: false, untrustedContentGuard: false });
  const settings = await loadSettings(root, { env });
  assert.notEqual(settings.allowUnrequestedGitWrites, true);
  assert.notEqual(settings.untrustedContentGuard, false);
  assert.equal(settings.textToolCalls, false);
});

test('every session.settings key the code reads is produced by the settings loader', async () => {
  const { readdir, readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
  const loader = await readFile(path.join(src, 'settings.mjs'), 'utf8');
  const missing = [];
  for (const name of (await readdir(src)).filter((file) => file.endsWith('.mjs'))) {
    const text = await readFile(path.join(src, name), 'utf8');
    for (const match of text.matchAll(/session\.settings(?: && session\.settings)?\.([a-zA-Z]+)/g)) {
      const key = match[1];
      if (!new RegExp('result\\.' + key + '\\b|\\b' + key + ':').test(loader)) missing.push(name + ': ' + key);
    }
  }
  assert.deepEqual([...new Set(missing)], []);
});
