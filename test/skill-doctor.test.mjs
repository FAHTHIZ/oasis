import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import '../src/tools.mjs';
import { skillDoctor, skillDoctorText, skillDenied } from '../src/skill-doctor.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function workspace() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-skilldoc-'));
  for (const [name, desc] of [['used-skill', 'Often used'], ['idle-skill', 'Never used but has a long description '.repeat(5)]]) {
    await mkdir(path.join(root, '.claude', 'skills', name), { recursive: true });
    await writeFile(path.join(root, '.claude', 'skills', name, 'SKILL.md'), '---\nname: ' + name + '\ndescription: ' + desc + '\n---\n' + 'Body text. '.repeat(40));
  }
  const cfg = path.join(root, 'cfg');
  await mkdir(path.join(cfg, 'sessions', 'p'), { recursive: true });
  await writeFile(path.join(cfg, 'sessions', 'p', 's.json'), JSON.stringify({ schemaVersion: 1, updatedAt: new Date().toISOString(), messages: [
    { role: 'user', content: '/used-skill go' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'a', function: { name: 'load_skill', arguments: '{"name":"used-skill"}' } }] }
  ] }));
  return { root, env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: cfg } };
}

test('skill-doctor reports listing cost, body cost and usage', async () => {
  const { root, env } = await workspace();
  const report = await skillDoctor(root, { env, settings: { permissions: { deny: [] } } });
  const used = report.rows.find((row) => row.name === 'used-skill');
  const idle = report.rows.find((row) => row.name === 'idle-skill');
  assert.equal(used.uses, 2);
  assert.equal(idle.uses, 0);
  assert.ok(idle.listing > used.listing);
  assert.ok(used.body > 50);
  const text = skillDoctorText(report);
  assert.match(text, /idle-skill.*on, unused/);
  assert.match(text, /Skill\(/);
  assert.ok(skillDenied('idle-skill', ['Skill(idle-*)']));
  assert.ok(!skillDenied('used-skill', ['Skill(idle-skill)']));
});

test('Skill(name) deny rules hide the skill and block load_skill', async (t) => {
  const { root, env } = await workspace();
  const settings = { permissions: { allow: [], ask: [], deny: ['Skill(idle-skill)'], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
  const { config, requests } = await scriptedModel(t, [toolCall('a', 'load_skill', { name: 'idle-skill' }), { content: 'ok' }]);
  const session = await createSession({ root, config, settings, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'go', { env, approval: async () => true });
  const system = requests[0].messages[0].content;
  assert.match(system, /used-skill/);
  assert.doesNotMatch(system, /idle-skill/);
  const tool = requests[1].messages.find((m) => m.role === 'tool');
  assert.doesNotMatch(tool.content, /Body text/);
  assert.match(tool.content, /den/i);
});
