import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm, realpath, chmod } from 'node:fs/promises';
import { resolveSandbox, wrapCommand, macProfile, detectSandbox, sandboxReadBlock } from '../src/sandbox.mjs';
import { srtConfig } from '../src/sandbox-runtime.mjs';

const repoFile = fileURLToPath(new URL('../package.json', import.meta.url));

async function tmp(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oasis-rblock-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(t, values) {
  const saved = {};
  for (const [key, value] of Object.entries(values)) { saved[key] = process.env[key]; process.env[key] = value; }
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}

async function layout(t) {
  const home = await tmp(t);
  const root = path.join(home, 'work');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'src', 'a.txt'), 'inside');
  await mkdir(path.join(home, 'private'));
  await writeFile(path.join(home, 'private', 'notes.txt'), 'outside');
  await writeFile(path.join(home, '.gitconfig'), '[user]\n\tname = Tester\n');
  await writeFile(path.join(home, '.git-credentials'), 'https://u:secret@example.com');
  await mkdir(path.join(home, 'tools', 'node', 'bin'), { recursive: true });
  await writeFile(path.join(home, 'tools', 'node', 'bin', 'hello'), '#!/bin/sh\necho hello-tool\n');
  await chmod(path.join(home, 'tools', 'node', 'bin', 'hello'), 0o755);
  withEnv(t, { HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), PATH: path.join(home, 'tools', 'node', 'bin') + path.delimiter + process.env.PATH });
  return { home, root };
}

test('the read block hides home and user-file roots and re-opens PATH tools and git config, not credentials', async (t) => {
  const { home, root } = await layout(t);
  const block = sandboxReadBlock(root);
  assert.ok(block.hidden.some((item) => item.path === home));
  const reopened = block.reopen.map((item) => item.path);
  assert.ok(reopened.includes(path.join(home, 'tools', 'node')), 'toolchain prefix on PATH');
  assert.ok(reopened.includes(path.join(home, '.gitconfig')));
  assert.ok(!reopened.some((item) => item.includes('.git-credentials')));
  const off = resolveSandbox({ sandbox: { enabled: true } }, root);
  assert.equal(off.readBlock, undefined, 'only with blockReadsOutsideWorkingDirectories');
  const managedOnly = resolveSandbox({ permissions: { blockReadsOutsideWorkingDirectories: true }, sandbox: { enabled: true, allowManagedReadPathsOnly: true } }, root);
  assert.equal(managedOnly.readBlock, undefined, 'allowManagedReadPathsOnly turns the sandbox part off');
  const container = resolveSandbox({ permissions: { blockReadsOutsideWorkingDirectories: true }, sandbox: { enabled: true, backend: 'docker' } }, root);
  assert.equal(container.readBlock, undefined, 'containers only mount the working folders anyway');
  const on = { ...resolveSandbox({ permissions: { blockReadsOutsideWorkingDirectories: true }, sandbox: { enabled: true, writableCaches: false } }, root), available: true };
  assert.ok(on.readBlock);
  const profile = macProfile({ ...on, kind: 'sandbox-exec' });
  assert.ok(profile.indexOf('(allow file-read* (subpath ' + JSON.stringify(root)) > profile.indexOf('(deny file-read* (subpath ' + JSON.stringify(home)));
  const srt = srtConfig(on);
  assert.ok(srt.filesystem.denyRead.includes(home));
  assert.ok(srt.filesystem.allowRead.includes(root));
});

test('repository allowWrite entries do not count under the block', async (t) => {
  const { home, root } = await layout(t);
  const settings = { permissions: { blockReadsOutsideWorkingDirectories: true }, sandbox: { enabled: true, writableCaches: false, allowWrite: [path.join(home, 'private')], allowWriteRepo: [path.join(home, 'private')] } };
  assert.ok(!resolveSandbox(settings, root).writable.includes(path.join(home, 'private')));
  assert.ok(resolveSandbox({ ...settings, permissions: {} }, root).writable.includes(path.join(home, 'private')));
});

const bwrapReady = process.platform === 'linux' && detectSandbox(true).available && detectSandbox(true).kind === 'bubblewrap';

test('bubblewrap: sandboxed commands read the working folder, tools and git config but not the rest of home', { skip: !bwrapReady }, async (t) => {
  const { home, root } = await layout(t);
  const sandbox = resolveSandbox({ permissions: { blockReadsOutsideWorkingDirectories: true }, sandbox: { enabled: true, writableCaches: false } }, root, true);
  const run = (script) => { const wrapped = wrapCommand('/bin/sh', ['-c', script], sandbox, root); return spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', env: process.env }); };
  assert.equal(run('cat src/a.txt').stdout, 'inside');
  assert.equal(run('cat ' + path.join(home, 'private', 'notes.txt')).status === 0, false);
  assert.equal(run('cat ' + path.join(home, '.git-credentials')).status === 0, false);
  assert.match(run('cat ' + path.join(home, '.gitconfig')).stdout, /Tester/);
  assert.equal(run('hello').stdout, 'hello-tool\n');
  assert.equal(run('echo made > out.txt && cat out.txt').stdout, 'made\n');
  if (repoFile.startsWith('/home/') || repoFile.startsWith('/root/')) assert.equal(run('cat ' + repoFile).status === 0, false, 'files under /home or /root are hidden');
});

test('bubblewrap: git keeps working in a linked worktree under the block', { skip: !bwrapReady || spawnSync('git', ['--version']).status !== 0 }, async (t) => {
  const { home } = await layout(t);
  const repo = path.join(home, 'repo');
  await mkdir(repo);
  const git = (cwd, ...args) => spawnSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd, encoding: 'utf8' });
  git(repo, 'init', '-q');
  await writeFile(path.join(repo, 'f.txt'), 'x');
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'init');
  const wt = path.join(home, 'wt');
  git(repo, 'worktree', 'add', '-q', wt);
  const sandbox = resolveSandbox({ permissions: { blockReadsOutsideWorkingDirectories: true }, sandbox: { enabled: true, writableCaches: false } }, wt, true);
  assert.ok(sandbox.readBlock.reopen.some((item) => item.writable && item.path === path.join(repo, '.git')));
  const wrapped = wrapCommand('/bin/sh', ['-c', 'echo y > g.txt && git add g.txt && git -c user.name=T -c user.email=t@example.com commit -qm two && git log --oneline | wc -l'], sandbox, wt);
  const result = spawnSync(wrapped.command, wrapped.args, { encoding: 'utf8', env: process.env });
  assert.equal(result.stdout.trim(), '2', result.stderr);
});
