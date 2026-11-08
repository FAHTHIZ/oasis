import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { normalizePermissionMode, PERMISSION_MODES } from '../src/permission-modes.mjs';
import { loadSettings } from '../src/settings.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

function settingsWith(permissions) {
  return { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default', ...permissions }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
}

function twoCalls() {
  return [
    { content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: process.execPath, args: ['ok.js'] }) } },
      { id: 'c2', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'git', args: ['init', '--quiet', 'sub'] }) } }
    ] },
    { content: 'done' }
  ];
}

test('dontAsk is a canonical mode with dont-ask aliases', () => {
  assert.ok(PERMISSION_MODES.includes('dontAsk'));
  assert.equal(normalizePermissionMode('dont-ask'), 'dontAsk');
  assert.equal(normalizePermissionMode('DONT_ASK'), 'dontAsk');
});

for (const variant of ['mode', 'setting']) {
  test('never-prompt (' + variant + '): allowed calls run, prompting calls are denied and the turn continues', async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-dontask-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    await writeFile(path.join(root, 'ok.js'), 'console.log("allowed-ran")');
    const { config, requests } = await scriptedModel(t, twoCalls());
    const permissions = { allow: ['run_command(' + process.execPath + ' ok.js)'], ...(variant === 'setting' ? { denyInsteadOfPrompting: true } : {}) };
    const session = await createSession({ root, config, settings: settingsWith(permissions), ...(variant === 'mode' ? { permissionMode: 'dontAsk' } : {}) });
    const prompts = [];
    const result = await runAgentTurn(session, 'run', { approval: async (message) => { prompts.push(message); return true; } });
    const tools = requests[1].messages.filter((m) => m.role === 'tool');
    assert.match(tools[0].content, /allowed-ran/);
    assert.match(tools[1].content, /Denied without prompting/);
    assert.equal(prompts.length, 0, 'the user is never asked');
    assert.match(String(result.text || result), /done/);
  });
}

test('denyInsteadOfPrompting is honored from an untrusted project (it only tightens)', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-dontask-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-dontask-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.join(root, '.oasis'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'settings.json'), JSON.stringify({ permissions: { denyInsteadOfPrompting: true } }));
  const settings = await loadSettings(root, { ...process.env, HOME: home, OASIS_HOME: path.join(home, '.oasis') });
  assert.equal(settings.permissions.denyInsteadOfPrompting, true);
});
