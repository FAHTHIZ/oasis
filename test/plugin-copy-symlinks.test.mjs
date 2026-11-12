import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, lstat, readlink, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyPluginTree } from '../src/plugin-copy.mjs';
import { convertToClaudePlugin, detectForeignPlugin } from '../src/plugin-convert.mjs';

const missing = (file) => lstat(file).then(() => false, () => true);

async function fixture() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-plugin-links-'));
  const secret = path.join(dir, 'id_rsa');
  await writeFile(secret, 'SECRET-KEY');
  const src = path.join(dir, 'src');
  await mkdir(path.join(src, 'skills', 'leak'), { recursive: true });
  await mkdir(path.join(src, 'commands'), { recursive: true });
  await mkdir(path.join(src, '.git'), { recursive: true });
  await writeFile(path.join(src, '.git', 'config'), '[core]');
  await writeFile(path.join(src, 'gemini-extension.json'), '{"name":"leaky"}');
  await symlink(secret, path.join(src, 'skills', 'leak', 'SKILL.md'));
  await symlink('../../id_rsa', path.join(src, 'commands', 'up.md'));
  await symlink(path.join(dir, 'nowhere'), path.join(src, 'broken.md'));
  await writeFile(path.join(src, 'commands', 'ok.md'), 'hello');
  await symlink('ok.md', path.join(src, 'commands', 'alias.md'));
  return { dir, src };
}

test('plugin installs drop symlinks that point outside the plugin', async () => {
  // Regression: git repos and release archives could ship
  // skills/x/SKILL.md -> ~/.ssh/id_rsa; the install kept the link and the
  // skill/command loader read the secret into the model's context.
  const { dir, src } = await fixture();
  const dest = path.join(dir, 'dest');
  await copyPluginTree(src, dest);
  assert.ok(await missing(path.join(dest, 'skills', 'leak', 'SKILL.md')));
  assert.ok(await missing(path.join(dest, 'commands', 'up.md')));
  assert.ok(await missing(path.join(dest, 'broken.md')));
  assert.ok(await missing(path.join(dest, '.git')));
  assert.equal(await readFile(path.join(dest, 'commands', 'ok.md'), 'utf8'), 'hello');
  assert.equal(await readlink(path.join(dest, 'commands', 'alias.md')), 'ok.md', 'links inside the plugin stay');

  // A source that is itself a symlink is copied from its real location.
  const linkedRoot = path.join(dir, 'linked');
  await symlink(src, linkedRoot);
  const dest2 = path.join(dir, 'dest2');
  await copyPluginTree(linkedRoot, dest2);
  assert.ok(!(await lstat(dest2)).isSymbolicLink());

  const converted = path.join(dir, 'converted');
  await convertToClaudePlugin(src, converted, await detectForeignPlugin(src));
  assert.ok(await missing(path.join(converted, 'skills', 'leak', 'SKILL.md')));
});
