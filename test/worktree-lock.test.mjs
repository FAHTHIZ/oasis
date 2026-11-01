import test from 'node:test';
import assert from 'node:assert/strict';
import { withRepoWorktreeLock, retryOnGitLock } from '../src/worktrees.mjs';

test('worktree operations on one repository run one at a time', async () => {
  let active = 0;
  let peak = 0;
  const order = [];
  const op = (name, ms) => withRepoWorktreeLock('/repo/a', async () => {
    active += 1; peak = Math.max(peak, active); order.push('start ' + name);
    await new Promise((resolve) => setTimeout(resolve, ms));
    order.push('end ' + name); active -= 1;
    return name;
  });
  const results = await Promise.all([op('add', 30), op('remove', 5), op('prune', 1)]);
  assert.deepEqual(results, ['add', 'remove', 'prune']);
  assert.equal(peak, 1);
  assert.deepEqual(order, ['start add', 'end add', 'start remove', 'end remove', 'start prune', 'end prune']);
});

test('a failed worktree operation releases the lock for the next one', async () => {
  await assert.rejects(withRepoWorktreeLock('/repo/b', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await withRepoWorktreeLock('/repo/b', async () => 'next'), 'next');
});

test('different repositories do not wait on each other', async () => {
  let release;
  const held = withRepoWorktreeLock('/repo/c', () => new Promise((resolve) => { release = resolve; }));
  assert.equal(await withRepoWorktreeLock('/repo/d', async () => 'independent'), 'independent');
  release();
  await held;
});

test('git lock errors are retried; other errors are not', async () => {
  let calls = 0;
  const value = await retryOnGitLock(async () => {
    calls += 1;
    if (calls < 3) throw new Error("fatal: Unable to create '/r/.git/index.lock': File exists.");
    return 'ok';
  }, { delayMs: 1 });
  assert.equal(value, 'ok');
  assert.equal(calls, 3);

  let other = 0;
  await assert.rejects(retryOnGitLock(async () => { other += 1; throw new Error('fatal: not a git repository'); }, { delayMs: 1 }), /not a git repository/);
  assert.equal(other, 1);

  let persistent = 0;
  await assert.rejects(retryOnGitLock(async () => { persistent += 1; throw new Error('cannot lock ref refs/heads/x'); }, { attempts: 3, delayMs: 1 }), /cannot lock ref/);
  assert.equal(persistent, 3);
});
