import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile, readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

async function repo(t) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oasis-ew-')));
  t.after(() => rm(root, { recursive: true, force: true }));
  git(root, 'init', '-q'); git(root, 'config', 'user.email', 't@t'); git(root, 'config', 'user.name', 't');
  await writeFile(path.join(root, 'a.txt'), 'main\n');
  git(root, 'add', '.'); git(root, 'commit', '-qm', 'init');
  return root;
}

test('enter_worktree moves the session, writes land in the worktree, exit keep/remove', async (t) => {
  const root = await repo(t);
  const { config } = await scriptedModel(t, [
    toolCall('e1', 'enter_worktree', { name: 'feature' }),
    toolCall('w1', 'write_file', { path: 'b.txt', content: 'new in worktree\n' }),
    toolCall('x1', 'exit_worktree', { action: 'remove' }),
    toolCall('x2', 'exit_worktree', { action: 'keep' }),
    { content: 'done' }
  ]);
  config.maxSteps = 10;
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'work in a worktree');
  const tools = session.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  const entered = JSON.parse(tools[0]).entered;
  assert.ok(entered.startsWith(path.join(root, '.oasis', 'worktrees')), tools[0]);
  assert.ok(!existsSync(path.join(root, 'b.txt')), 'main checkout untouched');
  assert.equal(await readFile(path.join(entered, 'b.txt'), 'utf8'), 'new in worktree\n');
  assert.match(tools[2], /uncommitted change/);
  assert.match(tools[3], /Kept/);
  assert.equal(session.root, root);
  assert.ok(existsSync(entered));
});

test('enter_worktree with an outside path needs approval; non-worktrees are refused', async (t) => {
  const root = await repo(t);
  const outside = root + '-wt';
  t.after(() => rm(outside, { recursive: true, force: true }));
  git(root, 'worktree', 'add', '-q', '-b', 'side', outside);
  const other = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oasis-ew-other-')));
  t.after(() => rm(other, { recursive: true, force: true }));
  const { config } = await scriptedModel(t, [
    toolCall('e1', 'enter_worktree', { path: other }),
    toolCall('e2', 'enter_worktree', { path: outside }),
    { content: 'done' }
  ]);
  config.maxSteps = 10;
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  const asked = [];
  await runAgentTurn(session, 'enter', { approval: async (question) => { asked.push(question); return true; } });
  const tools = session.messages.filter((m) => m.role === 'tool').map((m) => m.content);
  assert.match(tools[0], /not a worktree of this repository/);
  assert.match(tools[1], /Working directory is now/);
  assert.ok(asked.some((q) => q.includes(outside)));
  assert.equal(session.root, outside);
});
