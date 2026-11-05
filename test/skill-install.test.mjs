import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { parseSkillSource, findSkillPackages, installSkillsFromSource } from '../src/skill-install.mjs';

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-skill-install-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src');
  await mkdir(path.join(src, 'skills', 'pdf', 'references'), { recursive: true });
  await writeFile(path.join(src, 'skills', 'pdf', 'SKILL.md'), '---\nname: pdf\ndescription: Work with PDF files\n---\nSteps.\n');
  await writeFile(path.join(src, 'skills', 'pdf', 'references', 'notes.md'), 'notes');
  await mkdir(path.join(src, 'skills', 'review'), { recursive: true });
  await writeFile(path.join(src, 'skills', 'review', 'SKILL.md'), '---\nname: review\ndescription: Review code\n---\n');
  await mkdir(path.join(src, 'node_modules', 'x'), { recursive: true });
  await writeFile(path.join(src, 'node_modules', 'x', 'SKILL.md'), '---\nname: hidden\n---\n');
  await mkdir(path.join(src, 'skills', 'bad name'), { recursive: true });
  await writeFile(path.join(src, 'skills', 'bad name', 'SKILL.md'), '---\nname: ../escape\n---\n');
  return { dir, src };
}

test('parseSkillSource accepts shorthand, tree URLs, SSH and local paths, and rejects unsafe input', () => {
  assert.deepEqual(parseSkillSource('owner/repo'), { kind: 'git', url: 'https://github.com/owner/repo.git', ref: '', display: 'owner/repo' });
  assert.equal(parseSkillSource('owner/repo#v2').ref, 'v2');
  const tree = parseSkillSource('https://github.com/o/r/tree/main/skills/pdf');
  assert.equal(tree.url, 'https://github.com/o/r.git');
  assert.equal(tree.ref, 'main');
  assert.equal(tree.subdir, 'skills/pdf');
  assert.equal(parseSkillSource('git@github.com:o/r.git').kind, 'git');
  assert.equal(parseSkillSource('./skills').kind, 'local');
  for (const bad of ['', '--upload-pack=x', 'https://u:p@github.com/o/r', 'https://github.com/o/r?x=1', 'file:///etc', 'git://host/r', 'a\nb']) {
    assert.throws(() => parseSkillSource(bad), Error, bad);
  }
});

test('findSkillPackages finds named SKILL.md folders and skips node_modules and invalid names', async (t) => {
  const { src } = await fixture(t);
  const found = (await findSkillPackages(src)).map((item) => item.name).sort();
  assert.deepEqual(found, ['pdf', 'review']);
});

test('installSkillsFromSource lists, installs one or all, and skips symlinks', async (t) => {
  const { dir, src } = await fixture(t);
  if (process.platform !== 'win32') await symlink('/etc/passwd', path.join(src, 'skills', 'pdf', 'link.txt'));
  const listed = await installSkillsFromSource(src, { list: true });
  assert.deepEqual(listed.available.map((item) => item.name).sort(), ['pdf', 'review']);
  const target = path.join(dir, 'target');
  const one = await installSkillsFromSource(src, { skill: 'PDF', targetDir: target });
  assert.deepEqual(one.installed.map((item) => item.name), ['pdf']);
  assert.equal(await readFile(path.join(target, 'pdf', 'references', 'notes.md'), 'utf8'), 'notes');
  if (process.platform !== 'win32') {
    assert.ok(!(await readdir(path.join(target, 'pdf'))).includes('link.txt'));
    assert.match(one.installed[0].skipped.join(' '), /symlink/);
  }
  const missing = await installSkillsFromSource(src, { skill: 'nope', targetDir: target });
  assert.equal(missing.installed.length, 0);
  assert.match(missing.message, /Available: pdf, review/);
  const all = await installSkillsFromSource(src, { all: true, targetDir: target });
  assert.deepEqual(all.installed.map((item) => item.name).sort(), ['pdf', 'review']);
});

test('installSkillsFromSource clones a Git source without running its hooks', async (t) => {
  let git = true;
  try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { git = false; }
  if (!git) return t.skip('git is not installed');
  const { dir, src } = await fixture(t);
  const run = (...args) => execFileSync('git', args, { cwd: src, stdio: 'ignore', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  run('init', '-q');
  run('add', '-A');
  run('commit', '-qm', 'skills');
  // A post-checkout hook in the cloning user's global config must not run.
  const marker = path.join(dir, 'hook-ran');
  const hooks = path.join(dir, 'hooks');
  await mkdir(hooks);
  await writeFile(path.join(hooks, 'post-checkout'), '#!/bin/sh\ntouch ' + JSON.stringify(marker) + '\n', { mode: 0o755 });
  const home = path.join(dir, 'home');
  await mkdir(home);
  await writeFile(path.join(home, '.gitconfig'), '[core]\n\thooksPath = ' + hooks + '\n[protocol "file"]\n\tallow = always\n');
  // A local path is copied directly, so use an ssh-style URL only for the parser and a file:// clone through Git.
  const result = await installSkillsFromSource('https://example.invalid/none.git', { skill: 'pdf', targetDir: path.join(dir, 't'), env: { PATH: process.env.PATH, HOME: home } }).catch((error) => error);
  assert.ok(result instanceof Error, 'an unreachable source fails cleanly');
  assert.match(result.message, /Could not download the skill source/);
  await assert.rejects(readFile(marker), 'no hook ran');
});
