import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { cloudCommand, cloudWorkflowYaml, createCloudClient, cloudBranch, CLOUD_WORKFLOW } from '../src/cloud.mjs';
import { publishChanges } from '../src/github-action.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

async function repo() {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-cloud-'));
  const origin = path.join(base, 'origin.git');
  const work = path.join(base, 'work');
  git(base, 'init', '-q', '--bare', '-b', 'main', origin);
  git(base, 'clone', '-q', origin, work);
  await writeFile(path.join(work, 'a.txt'), 'one\n');
  git(work, 'add', '-A'); git(work, 'commit', '-q', '-m', 'first'); git(work, 'push', '-q', 'origin', 'HEAD:main');
  return { base, origin, work };
}

// Real git, a stand-in for gh that records what it was asked.
function fakeExec(calls, { workflow = true, runs = [] } = {}) {
  return (command, args, options) => {
    if (command === 'git') {
      return new Promise((resolve, reject) => {
        try { resolve(execFileSync('git', args, { cwd: options.cwd, encoding: 'utf8', env: { ...process.env, ...options.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim()); }
        catch (error) { reject(new Error(String(error.stderr || error.message))); }
      });
    }
    calls.push(args);
    if (args[0] === 'workflow' && args[1] === 'view') return workflow ? Promise.resolve('name: x') : Promise.reject(new Error('not found'));
    if (args[0] === 'run' && args[1] === 'list') return Promise.resolve(JSON.stringify(runs));
    if (args[0] === 'run' && args[1] === 'view') return Promise.resolve(JSON.stringify({ status: 'completed', conclusion: 'success', url: 'https://github.com/o/r/actions/runs/7' }));
    return Promise.resolve('');
  };
}

test('the cloud workflow passes the task, branch and secrets to the OASIS action', () => {
  const yaml = cloudWorkflowYaml();
  assert.match(yaml, /workflow_dispatch:/);
  assert.match(yaml, /uses: FAHTHIZ\/oasis@main/);
  assert.match(yaml, /prompt: \$\{\{ inputs\.prompt \}\}/);
  assert.match(yaml, /branch: \$\{\{ inputs\.branch \}\}/);
  assert.match(yaml, /api_key: \$\{\{ secrets\.OASIS_API_KEY \}\}/);
  assert.match(yaml, /contents: write/);
});

test('oasis cloud setup writes the workflow once', async () => {
  const { work } = await repo();
  let out = '';
  const stdout = { write: (text) => { out += text; } };
  assert.equal(await cloudCommand(['setup'], { cwd: work, stdout }), 0);
  assert.match(out, /Added \.github\/workflows\/oasis-cloud\.yml/);
  assert.match(out, /gh secret set OASIS_API_KEY/);
  assert.equal(await readFile(path.join(work, '.github', 'workflows', CLOUD_WORKFLOW), 'utf8'), cloudWorkflowYaml());
  out = '';
  await cloudCommand(['setup'], { cwd: work, stdout });
  assert.match(out, /Already there/);
});

test('oasis cloud run dispatches the workflow with a fresh branch and remembers the task', async () => {
  const { work } = await repo();
  const calls = [];
  const now = Date.parse('2026-11-12T00:00:00Z');
  const client = createCloudClient({ cwd: work, exec: fakeExec(calls, { runs: [{ databaseId: 7, url: 'https://github.com/o/r/actions/runs/7', createdAt: '2026-11-12T00:00:05Z', event: 'workflow_dispatch' }] }) });
  const task = await client.start('Add a test for the parser', { model: 'gpt-x', now });
  assert.equal(task.branch, cloudBranch(task.id));
  const dispatch = calls.find((args) => args[0] === 'workflow' && args[1] === 'run');
  assert.deepEqual(dispatch.slice(0, 3), ['workflow', 'run', CLOUD_WORKFLOW]);
  assert.ok(dispatch.includes('prompt=Add a test for the parser'));
  assert.ok(dispatch.includes('branch=' + task.branch));
  assert.ok(dispatch.includes('model=gpt-x'));
  assert.ok(dispatch.includes('pull_request=false'));
  assert.ok(!dispatch.includes('--ref'));
  assert.equal(task.runId, 7);
  const saved = JSON.parse(await readFile(path.join(work, '.git', 'oasis-cloud-tasks.json'), 'utf8'));
  assert.equal(saved.tasks[0].id, task.id);
  const status = await client.status(task.id.slice(0, 6));
  assert.equal(status.conclusion, 'success');
});

test('oasis cloud run explains a missing workflow or task', async () => {
  const { work } = await repo();
  const client = createCloudClient({ cwd: work, exec: fakeExec([], { workflow: false }) });
  await assert.rejects(client.start('x'), /oasis cloud setup/);
  await assert.rejects(client.start('  '), /Say what/);
  await assert.rejects(client.pull(), /No cloud tasks yet/);
});

test('--here hands off uncommitted work without touching the working tree, and pull brings the result back', async () => {
  const { work, origin, base } = await repo();
  git(work, 'checkout', '-q', '-b', 'feature');
  await writeFile(path.join(work, 'a.txt'), 'one\ntwo\n');
  await writeFile(path.join(work, 'new.txt'), 'new file\n');
  const calls = [];
  const client = createCloudClient({ cwd: work, exec: fakeExec(calls) });
  const task = await client.start('Finish the feature', { here: true });
  assert.equal(task.branch, 'feature');
  const dispatch = calls.find((args) => args[0] === 'workflow' && args[1] === 'run');
  assert.deepEqual(dispatch.slice(-2), ['--ref', 'feature']);
  // The pushed commit carries the work in progress, new files included.
  assert.equal(git(base, '--git-dir', origin, 'show', 'feature:new.txt'), 'new file');
  assert.equal(git(base, '--git-dir', origin, 'show', 'feature:a.txt'), 'one\ntwo');
  // Nothing changed locally: still uncommitted, nothing staged.
  assert.equal(git(work, 'diff', '--cached', '--name-only'), '');
  assert.equal(git(work, 'diff', '--name-only'), 'a.txt');
  assert.match(git(work, 'status', '--porcelain'), /\?\? new\.txt/);

  // The runner continues on the branch and pushes.
  const runner = path.join(base, 'runner');
  git(base, 'clone', '-q', '-b', 'feature', origin, runner);
  await writeFile(path.join(runner, 'done.txt'), 'finished\n');
  const published = await publishChanges({ root: runner, trigger: { request: 'Finish the feature', author: 'me' }, context: { branch: 'feature', remote: 'origin', gitName: 'oasis', gitEmail: 'o@o', pushBranch: 'feature', openPullRequest: false }, request: () => { throw new Error('no PR expected'); }, summary: 'ok' });
  assert.equal(published.branch, 'feature');
  assert.equal(published.pullRequest, null);

  await assert.rejects(client.pull(task.id), /Commit or stash/);
  git(work, 'stash', '-u', '-q');
  const pulled = await client.pull(task.id);
  assert.match(pulled.log, /Finish the feature/);
  assert.equal(await readFile(path.join(work, 'done.txt'), 'utf8'), 'finished\n');
});

test('a cloud run from main gets its own branch on the runner', async () => {
  const { origin, base } = await repo();
  const runner = path.join(base, 'runner2');
  git(base, 'clone', '-q', origin, runner);
  await writeFile(path.join(runner, 'x.txt'), 'x\n');
  const published = await publishChanges({ root: runner, trigger: { request: 'Do x' }, context: { branch: 'main', remote: 'origin', gitName: 'oasis', gitEmail: 'o@o', pushBranch: 'oasis/cloud-abc', openPullRequest: false }, request: () => { throw new Error('no PR'); }, summary: 'ok' });
  assert.equal(published.branch, 'oasis/cloud-abc');
  assert.equal(git(base, '--git-dir', origin, 'show', 'oasis/cloud-abc:x.txt'), 'x');
  assert.equal(git(base, '--git-dir', origin, 'rev-parse', 'main'), git(runner, 'rev-parse', 'origin/main'), 'main is untouched');
});
