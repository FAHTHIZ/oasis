import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { webSlashCommands, expandWebSlashCommand } from '../src/web.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-webslash-'));
  const config = await mkdtemp(path.join(os.tmpdir(), 'oasis-webslash-cfg-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(config, { recursive: true, force: true })]));
  await mkdir(path.join(root, '.oasis', 'commands'), { recursive: true });
  await mkdir(path.join(root, '.oasis', 'skills', 'notes-writer'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'commands', 'ship.md'), '---\ndescription: Bump the version and tag a release\n---\nShip version $ARGUMENTS now.\n');
  await writeFile(path.join(root, '.oasis', 'skills', 'notes-writer', 'SKILL.md'), '---\nname: notes-writer\ndescription: Write release notes from the git log\n---\nRead git log and write notes.\n');
  const env = { ...process.env, OASIS_CONFIG_DIR: config, HOME: config, USERPROFILE: config, OASIS_IGNORE_CLAUDE_SETTINGS: '1' };
  return { root, env };
}

test('the browser slash menu lists built-ins, custom commands and skills', async (t) => {
  const { root, env } = await workspace(t);
  const list = await webSlashCommands(root, env);
  const byName = Object.fromEntries(list.map((item) => [item.name, item]));
  assert.equal(byName.help.kind, 'builtin');
  assert.equal(byName.language.kind, 'builtin');
  assert.equal(byName.resume, undefined, 'terminal-only commands are hidden');
  assert.equal(byName.copy, undefined);
  assert.equal(byName.exit, undefined);
  assert.equal(byName.ship.kind, 'command');
  assert.match(byName.ship.description, /Bump the version/);
  assert.equal(byName['notes-writer'].kind, 'skill');
  assert.equal(new Set(list.map((item) => item.name.toLowerCase())).size, list.length, 'no duplicates');
});

test('custom commands and skills typed in the browser expand like the terminal', async (t) => {
  const { root, env } = await workspace(t);
  const command = await expandWebSlashCommand(root, '/ship 2.1.0', env);
  assert.equal(command.kind, 'command');
  assert.match(command.prompt, /Ship version 2\.1\.0 now\./);
  const skill = await expandWebSlashCommand(root, '/notes-writer for v2', env);
  assert.equal(skill.kind, 'skill');
  assert.match(skill.prompt, /<skill name="notes-writer">[\s\S]*Read git log[\s\S]*Request: for v2/);
  assert.equal(await expandWebSlashCommand(root, '/nothing-here', env), null);
});
