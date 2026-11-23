import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm, access, mkdir } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { rewind } from '../src/checkpoints.mjs';
import {
  clearEffectRepoCache, diffSnapshots, disposeSnapshot, evaluateEffectContract, predictArgvEffects, predictShellEffects,
  restorePaths, snapshotWorkTree
} from '../src/effect-contracts.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function repo(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-effects-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q'], { cwd: root });
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  execFileSync('git', ['add', '-A'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init', '--allow-empty'], { cwd: root });
  clearEffectRepoCache();
  return root;
}

const gitOut = (root, args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });

test('the shadow predicts which paths a command line will write', () => {
  assert.deepEqual(predictShellEffects('sed -i s/a/b/ src/x.js').paths, ['src/x.js']);
  assert.deepEqual(predictShellEffects('echo hi > out.txt && cat a >> log/b.txt').paths.sort(), ['log/b.txt', 'out.txt']);
  assert.deepEqual(predictShellEffects('rm -rf build dist').paths.sort(), ['build', 'dist']);
  assert.deepEqual(predictShellEffects('ls | tee listing.txt').paths, ['listing.txt']);
  assert.deepEqual(predictShellEffects('mv a.txt b.txt').paths.sort(), ['a.txt', 'b.txt']);
  assert.deepEqual(predictShellEffects('echo x 2>/dev/null >/dev/null').paths, []);
  assert.equal(predictShellEffects('prettier --write .').broad, true);
  assert.deepEqual(predictShellEffects('npx prettier --write src/a.js').paths, ['src/a.js']);
  assert.equal(predictShellEffects('python3 gen.py').broad, true);
  assert.equal(predictShellEffects('git reset --hard HEAD~1').broad, true);
  assert.deepEqual(predictShellEffects('git checkout -- a.js').paths, ['a.js']);
  assert.ok(predictArgvEffects('npm', ['install', 'left-pad']).paths.includes('package-lock.json'));
  assert.deepEqual(predictArgvEffects('touch', ['new.md']).paths, ['new.md']);
});

test('snapshots observe exactly what a command changed, without touching the index', async (t) => {
  const root = await repo(t, { 'a.txt': 'one\n', 'b.txt': 'two\n', '.gitignore': 'ignored/\n' });
  await writeFile(path.join(root, 'staged.txt'), 'staged\n');
  execFileSync('git', ['add', 'staged.txt'], { cwd: root });
  const indexBefore = gitOut(root, ['ls-files', '-s']);
  const objectsBefore = gitOut(root, ['count-objects', '-v']);
  const statusBefore = gitOut(root, ['status', '--porcelain']);
  const before = await snapshotWorkTree(root);
  assert.equal(before.ok, true, before.reason);
  execFileSync('sh', ['-c', 'echo changed > a.txt; rm b.txt; echo new > c.txt; mkdir -p ignored; echo x > ignored/y'], { cwd: root });
  const after = await snapshotWorkTree(root);
  const changed = await diffSnapshots(before, after);
  assert.deepEqual(changed.map((item) => item.path + ':' + item.status).sort(), ['a.txt:modified', 'b.txt:deleted', 'c.txt:added']);
  assert.equal(gitOut(root, ['ls-files', '-s']), indexBefore, 'the user index is untouched');
  assert.equal(gitOut(root, ['stash', 'list']), '');
  assert.equal(gitOut(root, ['count-objects', '-v']), objectsBefore, 'no objects are written into the repository');
  t.after(() => Promise.all([disposeSnapshot(before), disposeSnapshot(after)]));
  assert.notEqual(gitOut(root, ['status', '--porcelain']), statusBefore);

  const contract = evaluateEffectContract({ predicted: predictShellEffects('echo changed > a.txt'), observed: changed });
  assert.equal(contract.held, false);
  assert.deepEqual(contract.unexpected.map((item) => item.path).sort(), ['b.txt', 'c.txt']);

  const undo = await restorePaths(root, before, changed.map((item) => item.path));
  assert.deepEqual(undo.restored.sort(), ['a.txt', 'b.txt']);
  assert.deepEqual(undo.deleted, ['c.txt']);
  assert.equal(await readFile(path.join(root, 'a.txt'), 'utf8'), 'one\n');
  assert.equal(await readFile(path.join(root, 'b.txt'), 'utf8'), 'two\n');
  await assert.rejects(access(path.join(root, 'c.txt')));
});

test('a workspace in a subfolder of the repository reports paths relative to itself', async (t) => {
  const top = await repo(t, { 'pkg/a.txt': '1\n', 'other/z.txt': 'z\n' });
  const root = path.join(top, 'pkg');
  const before = await snapshotWorkTree(root);
  await writeFile(path.join(root, 'a.txt'), '2\n');
  await writeFile(path.join(top, 'other/z.txt'), 'zz\n');
  const changed = await diffSnapshots(before, await snapshotWorkTree(root));
  assert.deepEqual(changed.map((item) => item.path).sort(), ['../other/z.txt', 'a.txt']);
  assert.equal(changed.find((item) => item.path === '../other/z.txt').outside, true);
});

test('large untracked files are left out of the snapshot instead of hashed', async (t) => {
  const root = await repo(t, { 'a.txt': 'a\n' });
  await writeFile(path.join(root, 'model.bin'), Buffer.alloc(64 * 1024, 1));
  const before = await snapshotWorkTree(root, { maxFileBytes: 1024 });
  t.after(() => disposeSnapshot(before));
  assert.equal(before.ok, true, before.reason);
  assert.deepEqual(before.excluded, ['model.bin']);
  const tooMuch = await snapshotWorkTree(root, { maxFileBytes: 1024 * 1024, maxUntrackedBytes: 1024 });
  assert.equal(tooMuch.ok, false);
  assert.equal(tooMuch.tooLarge, true);
});

test('outside a git work tree snapshots are unavailable, not wrong', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-effects-nogit-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  clearEffectRepoCache();
  const snap = await snapshotWorkTree(root);
  assert.equal(snap.ok, false);
});

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: true } };

test('a shell edit is observed, reported to the model and undone by /rewind', async (t) => {
  const root = await repo(t, { 'app.js': 'const version = 1;\n', 'notes.md': 'keep\n' });
  const seen = [];
  const { config, close } = await scriptedModel(t, [
    toolCall('s1', 'run_shell', { command: "sed -i 's/version = 1/version = 2/' app.js && echo generated > gen.txt" }),
    (payload) => { seen.push(payload.messages.filter((message) => message.role === 'tool').at(-1).content); return { content: 'Done.' }; }
  ], { registerTeardown: false });
  const session = await createSession({ root, config: { ...config, maxSteps: 4 }, settings, env: { ...process.env, OASIS_SANDBOX: '0' } });
  t.after(async () => { await closeSession(session); await close(); });
  await runAgentTurn(session, 'bump the version with sed', { autoApprove: true, approval: async () => true });
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'const version = 2;\n');
  const payload = JSON.parse(seen[0]);
  const effects = (payload.result || payload).effects;
  assert.ok(effects, seen[0]);
  assert.equal(effects.changed, 2);
  assert.equal(effects.unexpected, undefined, 'sed and the redirection predicted both files');
  assert.match(effects.note, /app\.js \(modified\)/);

  const undone = await rewind(session, 1, 'code');
  assert.deepEqual(undone.restored, ['app.js']);
  assert.deepEqual(undone.deleted, ['gen.txt']);
  assert.equal(await readFile(path.join(root, 'app.js'), 'utf8'), 'const version = 1;\n');
  await assert.rejects(access(path.join(root, 'gen.txt')));
});

test('changes the command line did not predict are named to the model', async (t) => {
  const root = await repo(t, { 'a.txt': 'a\n', 'gen': '#!/bin/sh\necho hidden > side-effect.txt\necho ok > a.txt\n' });
  execFileSync('chmod', ['+x', path.join(root, 'gen')]);
  const seen = [];
  const { config, close } = await scriptedModel(t, [
    toolCall('s1', 'run_shell', { command: './gen > report.txt' }),
    (payload) => { seen.push(payload.messages.filter((message) => message.role === 'tool').at(-1).content); return { content: 'Done.' }; }
  ], { registerTeardown: false });
  const session = await createSession({ root, config: { ...config, maxSteps: 4 }, settings, env: { ...process.env, OASIS_SANDBOX: '0' } });
  t.after(async () => { await closeSession(session); await close(); });
  await runAgentTurn(session, 'run the generator', { autoApprove: true, approval: async () => true });
  const payload = JSON.parse(seen[0]);
  const effects = (payload.result || payload).effects;
  assert.equal(effects.changed, 3, seen[0]);
  assert.deepEqual(effects.unexpected.sort(), ['a.txt (modified)', 'side-effect.txt (added)']);
  assert.equal(effects.held, false);
  assert.match(effects.note, /Not predicted from the command line/);
});

test('a read-only command is not snapshotted and a no-op command changes nothing', async (t) => {
  const root = await repo(t, { 'a.txt': 'a\n' });
  const seen = [];
  const { config, close } = await scriptedModel(t, [
    toolCall('s1', 'run_shell', { command: 'cat a.txt' }),
    toolCall('s2', 'run_shell', { command: 'node -e "1+1"' }),
    (payload) => { seen.push(...payload.messages.filter((message) => message.role === 'tool').map((message) => message.content)); return { content: 'Done.' }; }
  ], { registerTeardown: false });
  const session = await createSession({ root, config: { ...config, maxSteps: 5 }, settings, env: { ...process.env, OASIS_SANDBOX: '0' } });
  t.after(async () => { await closeSession(session); await close(); });
  await runAgentTurn(session, 'look', { autoApprove: true, approval: async () => true });
  const first = JSON.parse(seen[0]);
  assert.equal((first.result || first).effects, undefined);
  const second = JSON.parse(seen[1]);
  assert.deepEqual((second.result || second).effects, { changed: 0, held: true });
});

test('OASIS_EFFECT_CONTRACTS=0 turns observation off', async (t) => {
  const root = await repo(t, { 'a.txt': 'a\n' });
  const seen = [];
  const { config, close } = await scriptedModel(t, [
    toolCall('s1', 'run_shell', { command: 'echo b > a.txt' }),
    (payload) => { seen.push(payload.messages.filter((message) => message.role === 'tool').at(-1).content); return { content: 'Done.' }; }
  ], { registerTeardown: false });
  const env = { ...process.env, OASIS_SANDBOX: '0', OASIS_EFFECT_CONTRACTS: '0' };
  const session = await createSession({ root, config: { ...config, maxSteps: 4 }, settings, env });
  t.after(async () => { await closeSession(session); await close(); });
  await runAgentTurn(session, 'write', { autoApprove: true, approval: async () => true, env });
  const payload = JSON.parse(seen[0]);
  assert.equal((payload.result || payload).effects, undefined);
});
