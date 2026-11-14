// Every skill in a folder is found: a folder of 120 skills used to lose
// everything past the first 80 in directory order, and the total past 240.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { listAvailableSkills, loadSkillDescriptions } from '../src/tools.mjs';

test('300 workspace skills are all listed, and the prompt catalogue stays bounded', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-many-skills-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (let i = 0; i < 300; i++) {
    const dir = path.join(root, '.oasis', 'skills', 'skill-' + String(i).padStart(3, '0'));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), '---\nname: skill-' + String(i).padStart(3, '0') + '\ndescription: Skill number ' + i + ' for testing.\n---\nBody ' + i + '\n');
  }
  const env = { HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg'), OASIS_TRUST_WORKSPACE: '1', OASIS_DISABLE_BUNDLED_SKILLS: '1' };
  const skills = (await listAvailableSkills(root, { env, skillPolicy: { overrides: {}, disableBundled: true } })).filter((s) => /^skill-\d{3}$/.test(s.name));
  assert.equal(skills.length, 300);
  const catalogue = await loadSkillDescriptions(root, { env, skillPolicy: { overrides: {}, disableBundled: true }, maxChars: 2000 });
  assert.ok(catalogue.length <= 2000);
  assert.match(catalogue, /more skills not listed; call list_skills/);
});
