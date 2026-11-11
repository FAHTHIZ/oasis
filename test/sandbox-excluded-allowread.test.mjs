import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm, realpath, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { loadSettings } from '../src/settings.mjs';
import { resolveSandbox, wrapCommand, macProfile, detectSandbox } from '../src/sandbox.mjs';
import { simpleShellCommands, shellLineExcluded, argvExcluded } from '../src/sandbox-exclusions.mjs';
import { executeTool } from '../src/tools.mjs';

async function tmp(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oasis-sbx2-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('excludedCommands matches only calls made entirely of excluded commands', () => {
  const entries = ['docker *', 'make build', 'git *'];
  assert.equal(shellLineExcluded('docker build .', entries), true);
  assert.equal(shellLineExcluded('docker build . 2>&1 | docker logs x', entries), true);
  assert.equal(shellLineExcluded('docker', entries), false, 'docker * needs arguments; docker alone is an exact entry');
  assert.equal(shellLineExcluded('make build', entries), true);
  assert.equal(shellLineExcluded('make build-all', entries), false);
  assert.equal(shellLineExcluded('npm ci && docker build .', entries), false);
  for (const line of ['cd build && docker compose up', 'sudo docker ps', 'docker build . > build.log', 'docker run $(cat id)', 'docker run `id`', '(docker ps)', 'if true; then docker ps; fi', '$TOOL build', 'X=1 docker ps', 'docker run "$(id)"', 'docker ps <<EOF']) {
    assert.equal(shellLineExcluded(line, entries), false, line);
  }
  assert.equal(shellLineExcluded('git clone https://x/y vendor/lib', entries), true);
  assert.equal(shellLineExcluded('git clone https://x/y ~/tools', entries), false);
  assert.equal(shellLineExcluded('git worktree add ../elsewhere', entries), false);
  assert.equal(shellLineExcluded('git status', []), false);
  assert.deepEqual(simpleShellCommands("echo 'a && b' && ls"), [['echo', 'a && b'], ['ls']]);
  assert.equal(argvExcluded('docker', ['build', '.'], entries), true);
  assert.equal(argvExcluded('sudo', ['docker', 'ps'], entries), false);
  assert.equal(argvExcluded('git', ['init', '/abs'], entries), false);
});

test('excludedCommands and allowRead load from trusted settings; repository allowRead drops under blockReads', async (t) => {
  const root = await tmp(t);
  const home = await tmp(t);
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await mkdir(path.join(root, 'open'), { recursive: true });
  await writeFile(path.join(home, 'settings.json'), JSON.stringify({ sandbox: { excludedCommands: ['docker *'], filesystem: { denyRead: ['~/'] } } }));
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ sandbox: { enabled: true, excludedCommands: ['make *'], filesystem: { allowRead: ['./open'] } } }));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: '', OASIS_TRUST_WORKSPACE: '1' };
  const settings = await loadSettings(root, { env });
  assert.deepEqual(settings.sandbox.excludedCommands, ['docker *', 'make *']);
  assert.deepEqual(settings.sandbox.allowRead, [path.join(root, 'open')]);
  assert.deepEqual(settings.sandbox.allowReadRepo, [path.join(root, 'open')]);
  const blocked = resolveSandbox({ ...settings, sandbox: { ...settings.sandbox, denyRead: [root] }, permissions: { ...settings.permissions, blockReadsOutsideWorkingDirectories: true } }, root);
  assert.deepEqual(blocked.reopenedPaths, []);
  const open = resolveSandbox({ ...settings, sandbox: { ...settings.sandbox, denyRead: [root] } }, root);
  assert.deepEqual(open.reopenedPaths.map((item) => item.path), [path.join(root, 'open')]);
  assert.deepEqual(open.excludedCommands, ['docker *', 'make *']);
  const profile = macProfile({ ...open, writable: [root] });
  assert.ok(profile.indexOf('(allow file-read* (subpath ' + JSON.stringify(path.join(root, 'open'))) > profile.indexOf('(deny file-read* (subpath ' + JSON.stringify(root)));
});

const bwrapReady = process.platform === 'linux' && detectSandbox(true).available && detectSandbox(true).kind === 'bubblewrap';

test('bubblewrap re-opens allowRead inside denyRead and keeps an inner denyRead blocked', { skip: !bwrapReady }, async (t) => {
  const root = await tmp(t);
  const secret = await tmp(t);
  await mkdir(path.join(secret, 'open', 'inner'), { recursive: true });
  await writeFile(path.join(secret, 'hidden.txt'), 'hidden');
  await writeFile(path.join(secret, 'open', 'ok.txt'), 'ok');
  await writeFile(path.join(secret, 'open', 'inner', 'no.txt'), 'no');
  const sandbox = resolveSandbox({ sandbox: { enabled: true, maskSensitivePaths: false, writableCaches: false, denyRead: [secret, path.join(secret, 'open', 'inner')], allowRead: [path.join(secret, 'open')] } }, root, true);
  const cat = (file) => { const wrapped = wrapCommand('/bin/cat', [file], sandbox, root); return spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8' }).stdout; };
  assert.equal(cat(path.join(secret, 'hidden.txt')), '');
  assert.equal(cat(path.join(secret, 'open', 'ok.txt')), 'ok');
  assert.equal(cat(path.join(secret, 'open', 'inner', 'no.txt')), '');
});

test('an excluded run_shell call runs outside bubblewrap and asks for approval', { skip: !bwrapReady }, async (t) => {
  const root = await tmp(t);
  const outside = await tmp(t);
  const sandbox = resolveSandbox({ sandbox: { enabled: true, writableCaches: false, excludedCommands: ['touch *'] } }, root, true);
  const target = path.join(outside, 'made.txt');
  const prompts = [];
  const approval = async (text) => { prompts.push(text); return true; };
  const inSandbox = await executeTool('run_shell', { command: 'touch ' + target + ' && echo done' }, { root, sandbox, approval, env: process.env });
  assert.equal(existsSync(target), false, 'a call with a non-excluded command stays sandboxed: ' + JSON.stringify(inSandbox).slice(0, 300));
  const excluded = await executeTool('run_shell', { command: 'touch ' + target }, { root, sandbox, approval, env: process.env });
  assert.equal(existsSync(target), true, JSON.stringify(excluded).slice(0, 300));
  assert.equal(excluded.sandboxed, undefined);
  assert.ok(prompts.length >= 1, 'the excluded command went through approval');
  assert.equal(await readFile(target, 'utf8'), '');
});
