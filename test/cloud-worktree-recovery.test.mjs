import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { createCloudTaskStore } from '../src/cloud-task-store.mjs';
import { startOasisWebServer } from '../src/web.mjs';
import { createWorktree, removeWorktree } from '../src/worktrees.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
}

test('runtime restart marks an active task interrupted and exposes a safe partial worktree diff', async (t) => {
  const temp = await mkdtemp(path.join(os.tmpdir(), 'oasis-cloud-recovery-'));
  const root = path.join(temp, 'workspace');
  await mkdir(root, { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'oasis-recovery@example.invalid');
  git(root, 'config', 'user.name', 'Oasis Recovery Test');
  await writeFile(path.join(root, 'README.md'), '# Base version\n');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'Initial fixture');
  const worktree = await createWorktree(root, 'Interrupted recovery');
  await writeFile(path.join(worktree.path, 'README.md'), '# Partial tracked change\n');
  await writeFile(path.join(worktree.path, 'partial.txt'), 'Uncommitted progress survives the restart.\n');

  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(temp, 'config') };
  const id = randomUUID();
  const store = createCloudTaskStore(root, { env });
  await store.save({
    id,
    type: 'agent',
    title: 'Recover interrupted implementation',
    status: 'running',
    createdAt: new Date().toISOString(),
    workspaceName: worktree.branch,
    workspaceRoot: root,
    executionRoot: worktree.path,
    worktreePath: worktree.relative,
    worktreeBranch: worktree.branch,
    worktreeBaseCommit: worktree.base,
    events: [{ id: 1, type: 'started', at: new Date().toISOString(), data: { isolation: 'worktree' } }],
    nextEventId: 2,
    result: null,
    error: null
  });

  const app = await startOasisWebServer({
    root,
    host: '127.0.0.1',
    port: 0,
    env,
    token: 'cloud-recovery-test-token-123456789'
  });
  t.after(async () => {
    await app.close();
    await removeWorktree(root, worktree, { deleteBranch: true });
    await rm(temp, { recursive: true, force: true });
  });

  const base = 'http://127.0.0.1:' + app.port;
  const unauthorized = await fetch(base + '/api/jobs/' + id + '/diff');
  assert.equal(unauthorized.status, 401);

  const detailsResponse = await fetch(base + '/api/jobs/' + id, {
    headers: { authorization: 'Bearer ' + app.token }
  });
  assert.equal(detailsResponse.status, 200);
  const details = await detailsResponse.json();
  assert.equal(details.status, 'interrupted');
  assert.equal(details.worktree.branch, worktree.branch);

  const diffResponse = await fetch(base + '/api/jobs/' + id + '/diff', {
    headers: { authorization: 'Bearer ' + app.token }
  });
  assert.equal(diffResponse.status, 200, await diffResponse.clone().text());
  const diff = await diffResponse.json();
  assert.equal(diff.complete, false);
  assert.equal(diff.status, 'interrupted');
  assert.match(diff.diff, /Partial tracked change/);
  assert.match(diff.diff, /Uncommitted progress survives the restart/);
  assert.ok(diff.untrackedFiles.includes('partial.txt'));
});
