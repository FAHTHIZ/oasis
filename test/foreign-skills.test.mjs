import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listAvailableSkills, loadSkillText, loadSkillResource, skillLocation } from '../src/tools.mjs';

const skill = (name, marker) => '---\nname: ' + name + '\ndescription: ' + name + ' skill\n---\n' + marker + '\n';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-foreign-skills-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  const home = path.join(base, 'home');
  const write = async (file, text) => { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text); };
  await write(path.join(root, '.cursor/skills/cursor-one/SKILL.md'), skill('cursor-one', 'CURSOR-PROJECT'));
  await write(path.join(root, '.devin/skills/devin-one/SKILL.md'), skill('devin-one', 'DEVIN-PROJECT'));
  await write(path.join(root, '.windsurf/skills/wind-one/SKILL.md'), skill('wind-one', 'WINDSURF-PROJECT'));
  await write(path.join(root, '.openhands/skills/oh-one/SKILL.md'), skill('oh-one', 'OPENHANDS-PROJECT'));
  await write(path.join(root, '.openhands/skills/oh-one/references/notes.md'), 'OH-REFERENCE');
  await write(path.join(root, '.codex/skills/codex-one/SKILL.md'), skill('codex-one', 'CODEX-PROJECT'));
  await write(path.join(root, '.claude/skills/shared/SKILL.md'), skill('shared', 'CLAUDE-WINS'));
  await write(path.join(root, '.devin/skills/shared/SKILL.md'), skill('shared', 'DEVIN-LOSES'));
  await write(path.join(home, '.gemini/config/skills/ag-one/SKILL.md'), skill('ag-one', 'ANTIGRAVITY-GLOBAL'));
  await write(path.join(home, '.gemini/config/skills/ag-one/references/guide.md'), 'AG-REFERENCE');
  await write(path.join(home, '.config/devin/skills/devin-global/SKILL.md'), skill('devin-global', 'DEVIN-GLOBAL'));
  await write(path.join(home, '.agents/skills/agents-global/SKILL.md'), skill('agents-global', 'AGENTS-GLOBAL'));
  await write(path.join(home, '.openhands/skills/oh-global/SKILL.md'), skill('oh-global', 'OPENHANDS-GLOBAL'));
  await write(path.join(home, '.gemini/config/plugins/agplug/skills/ag-plugin/SKILL.md'), skill('ag-plugin', 'AG-PLUGIN'));
  await write(path.join(home, '.gemini/antigravity-cli/plugins/cliplug/skills/agcli-plugin/SKILL.md'), skill('agcli-plugin', 'AGCLI-PLUGIN'));
  await write(path.join(base, 'outside/SKILL.md'), skill('escaped', 'ESCAPED'));
  await mkdir(path.join(home, '.cursor/skills'), { recursive: true });
  await symlink(path.join(base, 'outside'), path.join(home, '.cursor/skills/escaped'));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), CLAUDE_CONFIG_DIR: path.join(base, 'claude'), OASIS_CONFIG_DIR: path.join(base, 'cfg'), CODEX_HOME: path.join(base, 'codex'), OASIS_OTHER_AGENT_RULES: '' };
  return { root, home, env };
}

test('skills from Cursor, Devin Desktop, Windsurf, Antigravity, OpenHands and Codex folders are listed and loadable', async (t) => {
  const { root, env } = await fixture(t);
  const skills = await listAvailableSkills(root, { env });
  const byName = Object.fromEntries(skills.map((item) => [item.name, item]));
  for (const name of ['cursor-one', 'devin-one', 'wind-one', 'oh-one', 'codex-one', 'ag-one', 'devin-global', 'agents-global', 'oh-global', 'ag-plugin', 'agcli-plugin']) assert.ok(byName[name], name);
  assert.ok(!byName.escaped, 'symlinked skill folders are skipped');
  assert.equal(byName['devin-one'].origin, '.devin/skills');
  assert.equal(byName['ag-one'].origin, '~/.gemini/config/skills');
  assert.equal(byName.shared.source, 'claude-project', 'native locations win a name clash');

  assert.match((await loadSkillText(root, 'devin-one', { env })).content, /DEVIN-PROJECT/);
  assert.match((await loadSkillText(root, 'ag-one', { env })).content, /ANTIGRAVITY-GLOBAL/);
  assert.match((await loadSkillText(root, 'oh-global', { env })).content, /OPENHANDS-GLOBAL/);
  assert.match((await loadSkillText(root, 'shared', { env })).content, /CLAUDE-WINS/);
  assert.match((await loadSkillResource(root, 'oh-one', 'references/notes.md', { env })).content, /OH-REFERENCE/);
  assert.match((await loadSkillResource(root, 'ag-one', 'references/guide.md', { env })).content, /AG-REFERENCE/);
  assert.equal(skillLocation(root, byName['ag-one']).scope, 'user');
  assert.equal(skillLocation(root, byName['cursor-one']).scope, 'repo');
});

test('OASIS_OTHER_AGENT_RULES=0 hides other agents\' skill folders', async (t) => {
  const { root, env } = await fixture(t);
  const names = (await listAvailableSkills(root, { env: { ...env, OASIS_OTHER_AGENT_RULES: '0' } })).map((item) => item.name);
  for (const name of ['cursor-one', 'devin-one', 'ag-one', 'oh-global']) assert.ok(!names.includes(name), name);
  assert.ok(names.includes('shared'));
});
