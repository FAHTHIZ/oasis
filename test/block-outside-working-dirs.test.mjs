import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm, realpath } from 'node:fs/promises';
import { loadSettings } from '../src/settings.mjs';
import { createSession, closeSession } from '../src/agent.mjs';
import { resolveWorkspacePath } from '../src/tools.mjs';

async function tmp(t) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'oasis-block-')));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function setup(t, { user, project } = {}) {
  const root = await tmp(t);
  const home = await tmp(t);
  const repoDir = await tmp(t);
  const userDir = await tmp(t);
  const fill = (value) => JSON.parse(JSON.stringify(value).replaceAll('REPO_DIR', repoDir).replaceAll('USER_DIR', userDir));
  if (user) await writeFile(path.join(home, 'settings.json'), JSON.stringify(fill(user)));
  if (project) { await mkdir(path.join(root, '.claude'), { recursive: true }); await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify(fill(project))); }
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: '', OASIS_TRUST_WORKSPACE: '1' };
  return { root, env, repoDir, userDir };
}

const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'x', apiKey: '' };

test('a true block key in any file applies, including an untrusted project', async (t) => {
  const s = await setup(t, { user: { permissions: { blockWritesOutsideWorkingDirectories: false } }, project: { permissions: { blockReadsOutsideWorkingDirectories: true, blockWritesOutsideWorkingDirectories: true } } });
  const env = { ...s.env };
  delete env.OASIS_TRUST_WORKSPACE;
  const settings = await loadSettings(s.root, { env });
  assert.equal(settings.trusted, false);
  assert.equal(settings.permissions.blockReadsOutsideWorkingDirectories, true);
  assert.equal(settings.permissions.blockWritesOutsideWorkingDirectories, true);
});

test('without the block, folders from the repository settings are working directories', async (t) => {
  const s = await setup(t, { project: { permissions: { additionalDirectories: ['REPO_DIR'] } } });
  const session = await createSession({ root: s.root, env: s.env, config });
  t.after(() => closeSession(session));
  assert.deepEqual(session.additionalDirectories, [s.repoDir]);
});

test('under the block, only your own additionalDirectories count and worktree switching is denied', async (t) => {
  const s = await setup(t, { user: { permissions: { additionalDirectories: ['USER_DIR'], blockWritesOutsideWorkingDirectories: true } }, project: { permissions: { additionalDirectories: ['REPO_DIR'] } } });
  await writeFile(path.join(s.repoDir, 'x.txt'), 'x');
  const session = await createSession({ root: s.root, env: s.env, config });
  t.after(() => closeSession(session));
  assert.deepEqual(session.additionalDirectories, [s.userDir]);
  await assert.rejects(() => resolveWorkspacePath(s.root, path.join(s.repoDir, 'x.txt')), /outside the workspace/);
  assert.equal(session.permissions.evaluate('enter_worktree', {}).decision, 'deny');
  assert.equal(session.permissions.evaluate('exit_worktree', {}).decision, 'deny');
});
