import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, chmod, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runGitTool } from '../src/git-tools.mjs';
import { TOOL_DEFINITIONS } from '../src/tools.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

const sh = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function repo() {
  const base = await mkdtemp(path.join(tmpdir(), 'oasis-git-'));
  const remote = path.join(base, 'remote.git');
  const root = path.join(base, 'work');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', root]);
  sh(root, 'config', 'user.name', 'Test');
  sh(root, 'config', 'user.email', 'test@example.com');
  sh(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, 'README.md'), '# demo\n');
  sh(root, 'add', '.');
  sh(root, 'commit', '-qm', 'Initial commit');
  sh(root, 'push', '-q', '-u', 'origin', 'main');
  return { base, root, remote };
}
const yes = { autoApprove: true };

test('git tools are registered', () => {
  for (const name of ['git_log', 'git_commit', 'git_branch', 'git_push', 'create_pull_request']) assert.ok(TOOL_DEFINITIONS.some((tool) => tool.function.name === name), name);
});

test('git_log lists commits', async () => {
  const { root } = await repo();
  const log = await runGitTool('git_log', root, { limit: 5 }, {});
  assert.equal(log.ok, true);
  assert.equal(log.branch, 'main');
  assert.equal(log.commits[0].subject, 'Initial commit');
  assert.equal(log.commits[0].author, 'Test');
});

test('git_commit asks first, stages selected paths, and passes the message safely', async () => {
  const { root } = await repo();
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'src', 'a.js'), 'export const a = 1;\n');
  await writeFile(path.join(root, 'notes.txt'), 'scratch\n');
  const prompts = [];
  const denied = await runGitTool('git_commit', root, { message: 'Add a' }, { approval: async (m) => { prompts.push(m); return false; } });
  assert.equal(denied.ok, false);
  assert.match(prompts[0], /src\/a\.js/);
  assert.equal(sh(root, 'status', '--porcelain').includes('A '), false, 'nothing staged after denial');
  const message = 'Add module a\n\nUses "$(rm -rf /)" and `backticks` literally; no shell is involved.';
  const done = await runGitTool('git_commit', root, { message, paths: ['src'] }, yes);
  assert.equal(done.ok, true);
  assert.equal(done.subject, 'Add module a');
  assert.equal(sh(root, 'log', '-1', '--format=%B'), message);
  assert.match(sh(root, 'status', '--porcelain'), /\?\? notes\.txt/, 'unselected file left alone');
  const all = await runGitTool('git_commit', root, { message: 'Add notes' }, yes);
  assert.equal(all.ok, true);
  assert.equal(sh(root, 'status', '--porcelain'), '');
  const empty = await runGitTool('git_commit', root, { message: 'Nothing' }, yes);
  assert.equal(empty.ok, false);
  assert.match(empty.message, /nothing to commit/i);
});

test('git_commit refuses secret-looking files and reports hook failures', async () => {
  const { root } = await repo();
  await writeFile(path.join(root, '.env'), 'API_KEY=123\n');
  await writeFile(path.join(root, 'app.js'), 'x\n');
  const blocked = await runGitTool('git_commit', root, { message: 'Add env' }, yes);
  assert.equal(blocked.ok, false);
  assert.deepEqual(blocked.blocked, ['.env']);
  const scoped = await runGitTool('git_commit', root, { message: 'Add app', paths: ['app.js'] }, yes);
  assert.equal(scoped.ok, true, 'committing other paths still works');
  if (process.platform === 'win32') return;
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\necho "lint failed: missing semicolon" >&2\nexit 1\n');
  await chmod(hook, 0o755);
  await writeFile(path.join(root, 'b.js'), 'y\n');
  const rejected = await runGitTool('git_commit', root, { message: 'Add b', paths: ['b.js'] }, yes);
  assert.equal(rejected.ok, false);
  assert.match(rejected.output, /lint failed/);
  assert.match(rejected.message, /hook/);
});

test('git_branch creates, switches, and validates names', async () => {
  const { root } = await repo();
  const made = await runGitTool('git_branch', root, { name: 'feature/x' }, yes);
  assert.equal(made.ok, true);
  assert.equal(made.created, true);
  assert.equal(sh(root, 'branch', '--show-current'), 'feature/x');
  const back = await runGitTool('git_branch', root, { name: 'main' }, yes);
  assert.equal(back.created, false);
  assert.equal(sh(root, 'branch', '--show-current'), 'main');
  await assert.rejects(runGitTool('git_branch', root, { name: '--force' }, yes), /Invalid/);
  await assert.rejects(runGitTool('git_branch', root, { name: 'a..b' }, yes), /Invalid/);
  const denied = await runGitTool('git_branch', root, { name: 'nope' }, { approval: async () => false });
  assert.equal(denied.ok, false);
});

test('git_push publishes the branch and never forces', async () => {
  const { root, remote } = await repo();
  await runGitTool('git_branch', root, { name: 'topic' }, yes);
  await writeFile(path.join(root, 'c.txt'), 'c\n');
  await runGitTool('git_commit', root, { message: 'Add c' }, yes);
  const pushed = await runGitTool('git_push', root, {}, yes);
  assert.equal(pushed.ok, true);
  assert.equal(sh(remote, 'log', '-1', '--format=%s', 'topic'), 'Add c');
  const again = await runGitTool('git_push', root, {}, yes);
  assert.match(again.message, /up to date/);
  // Diverge the remote; the push must be rejected, not forced.
  const other = path.join(path.dirname(root), 'other');
  execFileSync('git', ['clone', '-q', '-b', 'topic', remote, other]);
  sh(other, 'config', 'user.name', 'O'); sh(other, 'config', 'user.email', 'o@example.com');
  await writeFile(path.join(other, 'd.txt'), 'd\n');
  sh(other, 'add', '.'); sh(other, 'commit', '-qm', 'Remote change'); sh(other, 'push', '-q');
  await writeFile(path.join(root, 'e.txt'), 'e\n');
  await runGitTool('git_commit', root, { message: 'Local change' }, yes);
  const rejected = await runGitTool('git_push', root, {}, yes);
  assert.equal(rejected.ok, false);
  assert.match(rejected.message, /never force-pushes/);
  assert.equal(sh(remote, 'log', '-1', '--format=%s', 'topic'), 'Remote change');
});

test('create_pull_request refuses the base branch and calls gh with the body on stdin', async () => {
  if (process.platform === 'win32') return;
  const { base, root } = await repo();
  const bin = path.join(base, 'bin');
  await mkdir(bin);
  const log = path.join(base, 'gh.log');
  await writeFile(path.join(bin, 'gh'), '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "gh 2.0"; exit 0; fi\nif [ "$1" = "repo" ]; then echo main; exit 0; fi\necho "ARGS: $*" >> ' + JSON.stringify(log) + '\ncat >> ' + JSON.stringify(log) + '\necho https://github.com/o/r/pull/7\n');
  await chmod(path.join(bin, 'gh'), 0o755);
  const env = { ...process.env, PATH: bin + path.delimiter + process.env.PATH };
  const onMain = await runGitTool('create_pull_request', root, { title: 'T', body: 'B' }, { ...yes, env });
  assert.equal(onMain.ok, false);
  assert.match(onMain.message, /feature branch/);
  await runGitTool('git_branch', root, { name: 'feat/pr' }, yes);
  await writeFile(path.join(root, 'f.txt'), 'f\n');
  await runGitTool('git_commit', root, { message: 'Add f' }, yes);
  const pr = await runGitTool('create_pull_request', root, { title: 'Add f', body: '## Summary\n- adds f', draft: true }, { ...yes, env });
  assert.equal(pr.ok, true, JSON.stringify(pr));
  assert.equal(pr.url, 'https://github.com/o/r/pull/7');
  assert.equal(pr.base, 'main');
  const calls = await readFile(log, 'utf8');
  assert.match(calls, /pr create --title Add f --body-file - --base main --head feat\/pr --draft/);
  assert.match(calls, /## Summary/);
});

test('/commit and /pr send workflow prompts', async () => {
  const commit = await runBuiltinCommand('commit', 'mention the bug id', { root: '.' });
  assert.match(commit.prompt, /git_commit/);
  assert.match(commit.prompt, /mention the bug id/);
  const pr = await runBuiltinCommand('pr', 'develop', { root: '.' });
  assert.match(pr.prompt, /create_pull_request/);
  assert.match(pr.prompt, /develop/);
});
