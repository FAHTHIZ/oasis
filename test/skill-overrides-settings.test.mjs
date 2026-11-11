import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { listAvailableSkills, loadSkillDescriptions, loadSkillText } from '../src/tools.mjs';
import { loadSettings } from '../src/settings.mjs';
import { resolveCustomCommand } from '../src/commands.mjs';

async function workspace(settings) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-skillpol-'));
  const home = path.join(root, 'home');
  await mkdir(home, { recursive: true });
  for (const name of ['deploy', 'legacy-context', 'helper']) {
    await mkdir(path.join(root, '.claude', 'skills', name), { recursive: true });
    await writeFile(path.join(root, '.claude', 'skills', name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: The ' + name + ' skill description.\n---\nBody of ' + name + '\n');
  }
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify(settings));
  const env = { OASIS_CONFIG_DIR: home, HOME: home, CLAUDE_CONFIG_DIR: home, XDG_CONFIG_HOME: path.join(home, '.config'), OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: '', OASIS_OTHER_AGENT_RULES: '0', OASIS_TRUST_WORKSPACE: '1' };
  return { root, env };
}

test('skillOverrides hides, collapses or keeps skills', async () => {
  const { root, env } = await workspace({ skillOverrides: { deploy: 'off', 'legacy-context': 'name-only', helper: 'user-invocable-only', bogus: 'maybe' } });
  const names = (await listAvailableSkills(root, { env })).map((item) => item.name);
  assert.equal(names.includes('deploy'), false);
  const catalogue = await loadSkillDescriptions(root, { env });
  assert.match(catalogue, /- legacy-context \[claude-project\]\n|- legacy-context \[claude-project\]$/m);
  assert.doesNotMatch(catalogue, /legacy-context skill description/);
  assert.doesNotMatch(catalogue, /- helper\b/);
  assert.match((await loadSkillText(root, 'helper', { env })).content, /Body of helper/, '/helper still runs');
  await assert.rejects(loadSkillText(root, 'deploy', { env }), /No skill named/);
  const loaded = await loadSettings(root, { env });
  assert.deepEqual(loaded.skillOverrides, { deploy: 'off', 'legacy-context': 'name-only', helper: 'user-invocable-only' });
});

test('disableBundledSkills and CLAUDE_CODE_DISABLE_BUNDLED_SKILLS drop the built-in skills only', async () => {
  const plain = await workspace({});
  const before = await listAvailableSkills(plain.root, { env: plain.env });
  assert.ok(before.some((item) => item.source === 'built-in'));
  const viaEnv = await listAvailableSkills(plain.root, { env: { ...plain.env, CLAUDE_CODE_DISABLE_BUNDLED_SKILLS: '1' } });
  assert.equal(viaEnv.some((item) => item.source === 'built-in'), false);
  assert.ok(viaEnv.some((item) => item.name === 'deploy'));
  const { root, env } = await workspace({ disableBundledSkills: true });
  const after = await listAvailableSkills(root, { env });
  assert.equal(after.some((item) => item.source === 'built-in'), false);
  assert.ok(after.some((item) => item.name === 'helper'));
});

test('disableSkillShellExecution replaces inline shell in commands; a managed true cannot be undone', async () => {
  const { root, env } = await workspace({ disableSkillShellExecution: false });
  await mkdir(path.join(root, '.claude', 'commands'), { recursive: true });
  await writeFile(path.join(root, '.claude', 'commands', 'status.md'), 'State: !`echo ran-it`\n');
  const on = await resolveCustomCommand(root, '/status', { env, trusted: true });
  assert.match(on.prompt, /ran-it/);
  const off = await resolveCustomCommand(root, '/status', { env, trusted: true, disableShell: true });
  assert.match(off.prompt, /\[shell command execution disabled by policy\]/);
  assert.doesNotMatch(off.prompt, /ran-it/);
  const managed = path.join(root, 'managed.json');
  await writeFile(managed, JSON.stringify({ disableSkillShellExecution: true }));
  assert.equal((await loadSettings(root, { env: { ...env, OASIS_MANAGED_SETTINGS: managed } })).disableSkillShellExecution, true);
  assert.equal((await loadSettings(root, { env })).disableSkillShellExecution, false);
});
