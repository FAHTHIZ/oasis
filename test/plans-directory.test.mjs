import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { exitPlanMode, plansDirectoryFor } from '../src/plan-mode.mjs';
import { loadSettings } from '../src/settings.mjs';

function planSession(root, plansDirectory, env) {
  let mode = 'plan';
  return { root, sessionId: 'abc123', modelEnv: env, settings: { plansDirectory }, prePlanMode: 'default', permissions: { get mode() { return mode; }, setMode(next) { mode = next; } } };
}

test('plansDirectoryFor resolves inside the root and falls back outside it', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-plans-'));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'cfg') };
  assert.equal(plansDirectoryFor(root, '', env), null);
  assert.equal(plansDirectoryFor(root, './plans', env), path.join(root, 'plans'));
  assert.equal(plansDirectoryFor(root, '../plans', env), path.join(root, 'cfg', 'plans'));
  if (process.platform !== 'win32') assert.equal(plansDirectoryFor(root, 'docs\\plans', env), path.join(root, 'cfg', 'plans'));
});

test('exit_plan_mode saves the plan in plansDirectory and keeps one file per session', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-plans-'));
  const env = { OASIS_CONFIG_DIR: path.join(root, 'cfg') };
  const session = planSession(root, 'docs/plans', env);
  const first = await exitPlanMode(session, { plan: '1. Draft' }, { approval: async () => false }, {});
  assert.equal(first.approved, false);
  assert.equal(path.dirname(first.plan_file), path.join(root, 'docs', 'plans'));
  assert.equal(await readFile(first.plan_file, 'utf8'), '1. Draft\n');
  const second = await exitPlanMode(session, { plan: '1. Final' }, { approval: async () => true }, {});
  assert.equal(second.approved, true);
  assert.equal(second.plan_file, first.plan_file);
  assert.equal(await readFile(second.plan_file, 'utf8'), '1. Final\n');
  assert.equal((await readdir(path.join(root, 'docs', 'plans'))).length, 1);
  const none = await exitPlanMode(planSession(root, undefined, env), { plan: 'x' }, { approval: async () => false }, {});
  assert.equal(none.plan_file, undefined);
});

test('plansDirectory is ignored in an untrusted repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-plans-'));
  const home = path.join(root, 'home');
  await mkdir(path.join(root, '.claude'), { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify({ plansDirectory: './plans' }));
  const env = { OASIS_CONFIG_DIR: home, HOME: home, CLAUDE_CONFIG_DIR: home, OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: '' };
  assert.equal((await loadSettings(root, { env })).plansDirectory, undefined);
  assert.equal((await loadSettings(root, { env: { ...env, OASIS_TRUST_WORKSPACE: '1' } })).plansDirectory, './plans');
});
