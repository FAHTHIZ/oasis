import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, access, chmod, symlink, readdir, mkdir } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { listWorktrees, inspectWorktree, mergeWorktree, isCommitIntegrated, runWorktreeCommand } from '../src/worktrees.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

// These scripted fixtures overwrite files without reading them first; read-before-edit
// enforcement is covered by test/file-state.test.mjs.
process.env.OASIS_REQUIRE_READ_BEFORE_EDIT = '0';

function gitRepo(root) {
  const run = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  run('init', '-q', '-b', 'main');
  run('config', 'user.email', 't@example.com'); run('config', 'user.name', 'T');
  return run;
}

test('worktree subagents edit on their own branch and leave the main checkout untouched', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const run = gitRepo(root);
  await writeFile(path.join(root, 'app.txt'), 'version 1\n');
  run('add', '-A'); run('commit', '-qm', 'init');
  let parentCalls = 0;
  const childSeen = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    const payload = JSON.parse(body);
    const isChild = payload.messages[0].content.includes('SUBAGENT MODE');
    let message;
    if (isChild) {
      childSeen.push(payload);
      const sawTool = payload.messages.some((m) => m.role === 'tool');
      message = sawTool ? { content: 'Updated app.txt to version 2.' } : { content: null, tool_calls: [{ id: 'w1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'app.txt', content: 'version 2\n' }) } }] };
    } else {
      parentCalls++;
      message = parentCalls === 1
        ? { content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'bump version', prompt: 'Change app.txt to version 2', isolation: 'worktree' }) } }] }
        : { content: 'parent done' };
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const config = { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6, maxCommandSeconds: 10 };
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  const taskDef = session.toolDefinitions.find((d) => d.function.name === 'task');
  assert.deepEqual(taskDef.function.parameters.properties.isolation.enum, ['worktree']);
  const results = [];
  const outcome = await runAgentTurn(session, 'delegate in a worktree', { autoApprove: true, env, approval: async () => true, onToolResult: (e) => results.push(e) });
  assert.equal(outcome.text, 'parent done');
  assert.match(childSeen[0].messages[0].content, /ISOLATED WORKTREE/);
  assert.equal(await readFile(path.join(root, 'app.txt'), 'utf8'), 'version 1\n', 'main checkout unchanged');
  const taskResult = results.find((e) => e.name === 'task').result;
  assert.equal(taskResult.worktree.changed, true, JSON.stringify(taskResult));
  assert.deepEqual(taskResult.worktree.files, ['app.txt']);
  const branch = taskResult.worktree.branch;
  assert.match(branch, /^oasis\/bump-version-/);
  assert.equal(execFileSync('git', ['show', branch + ':app.txt'], { cwd: root }).toString(), 'version 2\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString(), '', 'worktrees are excluded from the parent status');
  const listed = await listWorktrees(root, { env });
  assert.equal(listed.length, 1);
  assert.equal(listed[0].branch, branch);
  const view = await runBuiltinCommand('worktrees', '', { root, env, session, sessionOptions: {} });
  assert.match(view.output, new RegExp(branch.replace('/', '\\/')));
});

test('worktree isolation refuses non-git folders and cleans up unchanged worktrees', async (t) => {
  const { createWorktree, finishWorktree } = await import('../src/worktrees.mjs');
  const plain = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-plain-'));
  t.after(() => rm(plain, { recursive: true, force: true }));
  await assert.rejects(createWorktree(plain, 'x'), /needs a git repository/);
  const run = gitRepo(plain);
  await assert.rejects(createWorktree(plain, 'x'), /at least one commit/);
  await writeFile(path.join(plain, 'a.txt'), 'a'); run('add', '-A'); run('commit', '-qm', 'i');
  const wt = await createWorktree(plain, 'Nothing To Do');
  assert.match(wt.branch, /^oasis\/nothing-to-do-/);
  const done = await finishWorktree(plain, wt);
  assert.equal(done.changed, false);
  await assert.rejects(access(wt.path));
  assert.equal(execFileSync('git', ['branch', '--list', wt.branch], { cwd: plain }).toString().trim(), '');
});


test('worktree isolation refuses a symlinked .oasis/worktrees destination', async (t) => {
  const { createWorktree } = await import('../src/worktrees.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-symlink-root-'));
  const outside = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-symlink-outside-'));
  t.after(() => Promise.all([
    rm(root, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true })
  ]));
  const run = gitRepo(root);
  await writeFile(path.join(root, 'README.md'), 'safe\n');
  run('add', '-A'); run('commit', '-qm', 'initial');
  await mkdir(path.join(root, '.oasis'));
  await symlink(outside, path.join(root, '.oasis', 'worktrees'), 'dir');
  await assert.rejects(createWorktree(root, 'escape'), /symbolic-link path|escapes the repository/);
  assert.deepEqual(await readdir(outside), [], 'no worktree contents were written outside the repository');
  assert.equal((await listWorktrees(root)).length, 0);
});

test('worktree merge preflight integrates disjoint changes and preserves the source worktree', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-merge-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-merge-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const run = gitRepo(root);
  await writeFile(path.join(root, 'agent.txt'), 'before\n');
  await writeFile(path.join(root, 'main.txt'), 'before\n');
  run('add', '-A'); run('commit', '-qm', 'init');
  const env = { ...process.env, HOME: home };
  const wt = await (await import('../src/worktrees.mjs')).createWorktree(root, 'disjoint change', { env });
  await writeFile(path.join(wt.path, 'agent.txt'), 'from agent\n');
  const workerResult = await (await import('../src/worktrees.mjs')).finishWorktree(root, wt, { env });
  assert.match(workerResult.commitSha, /^[0-9a-f]{40}$/i);
  assert.equal(await isCommitIntegrated(root, workerResult.commitSha, { env }), false, 'worker commit is not integrated just because its branch exists');
  await writeFile(path.join(root, 'main.txt'), 'from main\n');
  run('add', '-A'); run('commit', '-qm', 'main edit');
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  const preview = await inspectWorktree(root, wt.branch, { env });
  assert.equal(preview.can_merge, true);
  assert.deepEqual(preview.overlapping_files, []);
  assert.deepEqual(preview.merge_conflicts, []);
  const merged = await mergeWorktree(root, wt.branch, { env, expectedHead: before });
  assert.equal(merged.merged, true);
  assert.equal(await isCommitIntegrated(root, workerResult.commitSha, { env }), true, 'the merge makes the worker commit an ancestor of HEAD');
  assert.equal(await readFile(path.join(root, 'agent.txt'), 'utf8'), 'from agent\n');
  assert.equal(await readFile(path.join(root, 'main.txt'), 'utf8'), 'from main\n');
  assert.equal((await listWorktrees(root, { env })).length, 1);
});

test('worktree merge refuses conflicting or unreviewed overlapping changes', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-conflict-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-conflict-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const run = gitRepo(root);
  await writeFile(path.join(root, 'shared.txt'), 'one\ntwo\nthree\n');
  run('add', '-A'); run('commit', '-qm', 'init');
  const env = { ...process.env, HOME: home };
  const module = await import('../src/worktrees.mjs');
  const wt = await module.createWorktree(root, 'conflicting edit', { env });
  await writeFile(path.join(wt.path, 'shared.txt'), 'AGENT\ntwo\nthree\n');
  await module.finishWorktree(root, wt, { env });
  await writeFile(path.join(root, 'shared.txt'), 'MAIN\ntwo\nthree\n');
  run('add', '-A'); run('commit', '-qm', 'main edit');
  const preview = await inspectWorktree(root, wt.branch, { env });
  assert.ok(preview.merge_conflicts.length > 0);
  const before = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
  await assert.rejects(mergeWorktree(root, wt.branch, { env, expectedHead: before, allowOverlaps: true }), /predicts conflicts/);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim(), before);
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: root }).toString().trim(), '');
});


test('worktree completion runs hooks by default and only bypasses them when explicitly requested', async (t) => {
  if (process.platform === 'win32') { t.skip('Unix hook executable-bit behavior is platform-specific'); return; }
  const { createWorktree, finishWorktree } = await import('../src/worktrees.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-hooks-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = gitRepo(root);
  await writeFile(path.join(root, 'base.txt'), 'base\n');
  run('add', '-A'); run('commit', '-qm', 'init');
  const marker = path.join(root, '.git', 'pre-commit-ran');
  const hook = path.join(root, '.git', 'hooks', 'pre-commit');
  await writeFile(hook, '#!/bin/sh\nprintf ran > "' + marker + '"\nexit 42\n');
  await chmod(hook, 0o755);

  const ordinary = await createWorktree(root, 'normal hook policy');
  await writeFile(path.join(ordinary.path, 'normal.txt'), 'normal\n');
  await assert.rejects(finishWorktree(root, ordinary), /hook|commit/i);
  assert.equal(await readFile(marker, 'utf8'), 'ran', 'normal completion invoked the repository hook');

  await rm(marker);
  const unattended = await createWorktree(root, 'unattended worker policy');
  await writeFile(path.join(unattended.path, 'worker.txt'), 'worker\n');
  const result = await finishWorktree(root, unattended, { skipHooks: true });
  assert.equal(result.changed, true);
  await assert.rejects(access(marker), { code: 'ENOENT' }, 'the explicit unattended-worker exception must not run the hook');
});


async function waitForWorktreeMarker(file, timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { return await readFile(file, 'utf8'); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the timed Git process did not create its marker');
}

async function waitForWorktreeProcessExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let alive = true;
    try {
      process.kill(pid, 0);
      if (process.platform === 'linux') {
        const stat = await readFile('/proc/' + pid + '/stat', 'utf8').catch(() => '');
        const close = stat.lastIndexOf(')');
        if (close >= 0 && stat.slice(close + 1).trim().startsWith('Z ')) alive = false;
      }
    } catch (error) {
      alive = Boolean(error && error.code === 'EPERM');
    }
    if (!alive) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('worktree command process ' + pid + ' survived timeout');
}

test('worktree Git command timeout terminates a child and its descendant', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-process-tree-'));
  const marker = path.join(dir, 'pids.json');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const script = [
    "const { spawn } = require('node:child_process');",
    "const fs = require('node:fs');",
    "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
    "fs.writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid]));",
    "setInterval(() => {}, 1000);"
  ].join('\n');
  const result = await runWorktreeCommand(process.execPath, ['-e', script, marker], {
    cwd: dir,
    env: process.env,
    timeout: 1000
  });
  assert.equal(result.exitCode, 124, JSON.stringify(result));
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /timed out after 1000ms/);
  const pids = JSON.parse(await waitForWorktreeMarker(marker));
  assert.equal(pids.length, 2);
  await Promise.all(pids.map((pid) => waitForWorktreeProcessExit(pid)));
});
