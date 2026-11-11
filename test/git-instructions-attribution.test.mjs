import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession, attributionSection } from '../src/agent.mjs';

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-gitinst-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function repo(t, { user, project, managed } = {}) {
  const root = await tmp(t);
  const home = await tmp(t);
  const git = (...args) => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@e', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@e' } });
  git('init', '-q', '-b', 'feature-xyz');
  await writeFile(path.join(root, 'a.txt'), 'a');
  git('add', '.');
  git('commit', '-qm', 'distinctive-commit-subject');
  if (user) await writeFile(path.join(home, 'settings.json'), JSON.stringify(user));
  if (project) { await mkdir(path.join(root, '.claude'), { recursive: true }); await writeFile(path.join(root, '.claude', 'settings.json'), JSON.stringify(project)); }
  let managedFile = '';
  if (managed) { managedFile = path.join(home, 'managed.json'); await writeFile(managedFile, JSON.stringify(managed)); }
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), OASIS_IGNORE_CLAUDE_SETTINGS: '1', OASIS_MANAGED_SETTINGS: managedFile, OASIS_TRUST_WORKSPACE: '1' };
  delete env.CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS;
  return { root, env };
}

async function systemOf(t, r, env = r.env) {
  const session = await createSession({ root: r.root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:9/v1', model: 'x', apiKey: '' } });
  t.after(() => closeSession(session));
  return session.messages.find((message) => message.role === 'system').content;
}

test('the git snapshot is in the prompt by default and includeGitInstructions: false removes it', async (t) => {
  const on = await repo(t);
  const text = await systemOf(t, on);
  assert.match(text, /branch feature-xyz/);
  assert.match(text, /distinctive-commit-subject/);
  const off = await repo(t, { project: { includeGitInstructions: false } });
  const without = await systemOf(t, off);
  assert.match(without, /Git repository: yes/);
  assert.doesNotMatch(without, /feature-xyz|distinctive-commit-subject|Working tree:/);
});

test('CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS overrides includeGitInstructions both ways', async (t) => {
  const r = await repo(t, { user: { includeGitInstructions: false } });
  assert.match(await systemOf(t, r, { ...r.env, CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '0' }), /distinctive-commit-subject/);
  const plain = await repo(t);
  assert.doesNotMatch(await systemOf(t, plain, { ...plain.env, CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: '1' }), /distinctive-commit-subject/);
});

test('attribution.commit and attribution.pr reach the prompt; false or empty strings add nothing', async (t) => {
  assert.equal(attributionSection(null), '');
  assert.equal(attributionSection({ commit: '', pr: '' }), '');
  const r = await repo(t, { user: { attribution: { commit: 'Co-Authored-By: Bot <bot@example.com>', pr: 'Made with a bot' } } });
  const text = await systemOf(t, r);
  assert.match(text, /end it with exactly this text \(after a blank line\):\nCo-Authored-By: Bot <bot@example.com>/);
  assert.match(text, /pull request description, end it with exactly this text:\nMade with a bot/);
  assert.match(text, /user's own instructions about attribution take precedence/);
  const hidden = await repo(t, { user: { attribution: { commit: 'X-Trailer: 1' } }, managed: { attribution: false } });
  assert.doesNotMatch(await systemOf(t, hidden), /X-Trailer|Attribution \(from settings/);
  const org = await repo(t, { managed: { attribution: { commit: 'Org-Trailer: yes' } } });
  assert.match(await systemOf(t, org), /set by your organization\):\nWhen you write a git commit message, end it with exactly this text \(after a blank line\):\nOrg-Trailer: yes/);
});

test('attribution in an untrusted project is ignored', async (t) => {
  const r = await repo(t, { project: { attribution: { commit: 'Injected: yes' } } });
  const env = { ...r.env };
  delete env.OASIS_TRUST_WORKSPACE;
  assert.doesNotMatch(await systemOf(t, r, env), /Injected: yes/);
});
