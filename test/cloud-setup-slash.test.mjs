import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { runBuiltinCommand, COMMAND_ALIASES } from '../src/slash.mjs';
import { listAvailableSkills } from '../src/tools.mjs';

const tmp = () => mkdtemp(path.join(os.tmpdir(), 'oasis-cloudsetup-'));

test('/setup-bedrock detects a profile and saves env + pins to user settings', async (t) => {
  const home = await tmp();
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(path.join(home, '.aws'), { recursive: true });
  await writeFile(path.join(home, '.aws', 'config'), '[profile work]\nregion = us-west-2\n');
  const env = { HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg'), AWS_CONFIG_FILE: path.join(home, '.aws', 'config'), AWS_SHARED_CREDENTIALS_FILE: path.join(home, '.aws', 'none'), PATH: process.env.PATH };
  const preview = await runBuiltinCommand('setup-bedrock', 'region=us-west-2', { root: home, env });
  assert.match(preview.output, /AWS_PROFILE=work/);
  assert.match(preview.output, /Nothing saved/);
  const saved = await runBuiltinCommand('setup-bedrock', 'region=us-west-2 sonnet=my-profile-arn save', { root: home, env });
  assert.match(saved.output, /Saved to/);
  const settings = JSON.parse(await readFile(path.join(home, 'cfg', 'settings.json'), 'utf8'));
  assert.equal(settings.env.CLAUDE_CODE_USE_BEDROCK, '1');
  assert.equal(settings.env.AWS_REGION, 'us-west-2');
  assert.equal(settings.env.ANTHROPIC_DEFAULT_SONNET_MODEL, 'my-profile-arn');
  const vertex = await runBuiltinCommand('setup-vertex', 'project=my-proj save', { root: home, env: { ...env, PATH: '' } });
  assert.match(vertex.output, /ANTHROPIC_VERTEX_PROJECT_ID=my-proj/);
  const after = JSON.parse(await readFile(path.join(home, 'cfg', 'settings.json'), 'utf8'));
  assert.equal(after.env.CLAUDE_CODE_USE_VERTEX, '1');
  assert.equal(after.env.CLAUDE_CODE_USE_BEDROCK, undefined, 'only one cloud provider stays on');
  const confirmDeclined = await runBuiltinCommand('setup-vertex', 'project=x', { root: home, env, confirm: async () => false });
  assert.match(confirmDeclined.output, /Nothing saved/);
});

test('/bug drafts an issue URL without sending; aliases and new bundled skills exist', async () => {
  const out = await runBuiltinCommand('bug', 'crash on /resume', { root: process.cwd(), env: process.env });
  assert.match(out.output, /Nothing has been sent/);
  assert.match(out.output, /github\.com\/FAHTHIZ\/oasis\/issues\/new\?title=Bug%3A%20crash/);
  assert.equal(COMMAND_ALIASES.feedback, 'bug');
  assert.equal(COMMAND_ALIASES.quit, 'exit');
  assert.equal(COMMAND_ALIASES.new, 'clear');
  const skills = await listAvailableSkills(process.cwd());
  const names = JSON.stringify(skills);
  for (const name of ['workflow-authoring', 'plugin-authoring', 'run', 'verify']) assert.ok(names.includes('"' + name + '"'), name);
});
