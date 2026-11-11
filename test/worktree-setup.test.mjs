import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { createWorktree, removeWorktree } from '../src/worktrees.mjs';
import { worktreeSetupPlan, worktreeSetupSummary } from '../src/worktree-setup.mjs';

const unix = process.platform !== 'win32';

async function repo(t, files) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-setup-'));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo');
  await mkdir(root, { recursive: true });
  const run = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  run('init', '-q');
  run('config', 'user.email', 'test@example.com');
  run('config', 'user.name', 'Test');
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
  run('add', '-A');
  run('commit', '-qm', 'init');
  await writeFile(path.join(root, '.env'), 'SECRET=local\n');
  const env = { ...process.env, HOME: path.join(base, 'home'), OASIS_CONFIG_DIR: path.join(base, 'cfg'), OASIS_TRUST_WORKSPACE: '1' };
  return { root, env };
}

test('Cursor setup-worktree commands run in the new worktree with ROOT_WORKTREE_PATH', { skip: !unix }, async (t) => {
  const { root, env } = await repo(t, { '.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': ['cp "$ROOT_WORKTREE_PATH/.env" .env', 'echo ran > setup-marker.txt'] }) });
  const worktree = await createWorktree(root, 'cursor', { env });
  t.after(() => removeWorktree(root, worktree, { env }).catch(() => {}));
  assert.equal(worktree.setup.ok, true, JSON.stringify(worktree.setup));
  assert.equal(worktree.setup.ran, 2);
  assert.equal(await readFile(path.join(worktree.path, '.env'), 'utf8'), 'SECRET=local\n');
  assert.match(await readFile(path.join(worktree.path, 'setup-marker.txt'), 'utf8'), /ran/);
  assert.match(worktreeSetupSummary(worktree.setup), /Ran worktree setup from \.cursor\/worktrees\.json \(setup-worktree\) \(2 steps\)/);
});

test('the OS-specific key wins, script paths resolve next to worktrees.json and failures are reported', { skip: !unix }, async (t) => {
  const { root, env } = await repo(t, {
    '.cursor/worktrees.json': JSON.stringify({ 'setup-worktree-unix': 'setup.sh', 'setup-worktree': ['echo generic > generic.txt'] }),
    '.cursor/setup.sh': 'echo "from script $ROOT_WORKTREE_PATH" > script.txt\nexit 3\n'
  });
  const worktree = await createWorktree(root, 'script', { env });
  t.after(() => removeWorktree(root, worktree, { env }).catch(() => {}));
  assert.equal(worktree.setup.ok, false);
  assert.equal(worktree.setup.exitCode, 3);
  assert.match(await readFile(path.join(worktree.path, 'script.txt'), 'utf8'), new RegExp('from script ' + root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await assert.rejects(readFile(path.join(worktree.path, 'generic.txt')));
  assert.match(worktreeSetupSummary(worktree.setup), /failed at `setup\.sh` \(exit 3\)/);
  const windows = await worktreeSetupPlan(root, worktree.path, { platform: 'win32' });
  assert.equal(windows.source, '.cursor/worktrees.json (setup-worktree)');
});

test('Windsurf post_setup_worktree hooks run with ROOT_WORKSPACE_PATH', { skip: !unix }, async (t) => {
  const { root, env } = await repo(t, { '.windsurf/hooks.json': JSON.stringify({ hooks: { post_setup_worktree: [{ command: 'cp "$ROOT_WORKSPACE_PATH/.env" .env', show_output: true }] } }) });
  const worktree = await createWorktree(root, 'windsurf', { env });
  t.after(() => removeWorktree(root, worktree, { env }).catch(() => {}));
  assert.equal(worktree.setup.ok, true, JSON.stringify(worktree.setup));
  assert.equal(await readFile(path.join(worktree.path, '.env'), 'utf8'), 'SECRET=local\n');
});

test('setup does not run in an untrusted workspace, outside-repo scripts are refused, and it can be turned off', { skip: !unix }, async (t) => {
  const { root, env } = await repo(t, { '.cursor/worktrees.json': JSON.stringify({ 'setup-worktree': ['echo ran > setup-marker.txt'] }) });
  const untrusted = { ...env, OASIS_TRUST_WORKSPACE: '' };
  const worktree = await createWorktree(root, 'untrusted', { env: untrusted });
  t.after(() => removeWorktree(root, worktree, { env }).catch(() => {}));
  assert.equal(worktree.setup.skipped, true);
  assert.match(worktreeSetupSummary(worktree.setup), /not trusted\. Run `oasis trust`/);
  await assert.rejects(readFile(path.join(worktree.path, 'setup-marker.txt')));
  const off = await createWorktree(root, 'off', { env: { ...env, OASIS_WORKTREE_SETUP: '0' } });
  t.after(() => removeWorktree(root, off, { env }).catch(() => {}));
  assert.equal(off.setup, undefined);

  await writeFile(path.join(root, '.cursor', 'worktrees.json'), JSON.stringify({ 'setup-worktree': '../../outside.sh' }));
  await writeFile(path.join(path.dirname(root), 'outside.sh'), 'echo bad\n');
  const plan = await worktreeSetupPlan(root, path.join(root, 'nowhere'));
  assert.match(plan.error, /outside the repository/);
});
