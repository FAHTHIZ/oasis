import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm, access } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { createWorktree, finishWorktree, listWorktrees, readWorktreeWorkingDiff, removeWorktree } from '../src/worktrees.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

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

test('interrupted worktree diff includes tracked edits and safe previews of untracked text files', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = gitRepo(root);
  await writeFile(path.join(root, 'tracked.txt'), 'before\n');
  run('add', '-A'); run('commit', '-qm', 'base');
  const worktree = await createWorktree(root, 'Interrupted recovery');
  t.after(() => removeWorktree(root, worktree, { deleteBranch: true }));
  await writeFile(path.join(worktree.path, 'tracked.txt'), 'after\n');
  await writeFile(path.join(worktree.path, 'new-file.txt'), 'untracked progress\n');

  const result = await readWorktreeWorkingDiff(worktree.path, worktree.base);
  assert.match(result.diff, /before/);
  assert.match(result.diff, /after/);
  assert.match(result.diff, /new-file\.txt/);
  assert.match(result.diff, /untracked progress/);
  assert.ok(result.untrackedFiles.includes('new-file.txt'));
  assert.equal(result.truncated, false);
});

test('cloud task auto-commit blocks sensitive paths and keeps changes available for manual review', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-secret-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = gitRepo(root);
  await writeFile(path.join(root, 'README.md'), 'base\n');
  run('add', '-A'); run('commit', '-qm', 'base');
  const worktree = await createWorktree(root, 'Secret scan');
  t.after(() => removeWorktree(root, worktree, { deleteBranch: true }));
  await writeFile(path.join(worktree.path, '.env.local'), 'OPENAI_API_KEY=not-for-commit\n');
  await assert.rejects(finishWorktree(root, worktree, { blockSecrets: true }), /sensitive file paths were changed/i);
  assert.equal(await readFile(path.join(worktree.path, '.env.local'), 'utf8'), 'OPENAI_API_KEY=not-for-commit\n');
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree.path }).toString().trim(), worktree.base);
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: worktree.path }).toString(), /\.env\.local/);
});

test('cloud task auto-commit blocks common credential patterns inside changed text', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-secret-value-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const run = gitRepo(root);
  await writeFile(path.join(root, 'README.md'), 'base\n');
  run('add', '-A'); run('commit', '-qm', 'base');
  const worktree = await createWorktree(root, 'Token scan');
  t.after(() => removeWorktree(root, worktree, { deleteBranch: true }));
  await writeFile(path.join(worktree.path, 'config.txt'), 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345\n');
  await assert.rejects(finishWorktree(root, worktree, { blockSecrets: true }), /possible credentials were detected/i);
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: worktree.path }).toString().trim(), worktree.base);
  assert.match(execFileSync('git', ['status', '--porcelain'], { cwd: worktree.path }).toString(), /config\.txt/);
});

test('worktree isolation refuses non-git folders and cleans up unchanged worktrees', async (t) => {
  const { createWorktree, finishWorktree } = await import('../src/worktrees.mjs');
  const plain = await mkdtemp(path.join(os.tmpdir(), 'oasis-wt-plain-'));
  t.after(() => rm(plain, { recursive: true, force: true }));
  await assert.rejects(createWorktree(plain, 'x'), /needs a git repository/);
  const run = gitRepo(plain);
  await assert.rejects(createWorktree(plain, 'x'), /at least one commit/);
  await writeFile(path.join(plain, 'a.txt'), 'a'); run('add', '-A'); run('commit', '-qm', 'i');
  await writeFile(path.join(plain, 'dirty.txt'), 'uncommitted');
  await assert.rejects(createWorktree(plain, 'Dirty task', { requireClean: true }), /clean Git workspace/i);
  await rm(path.join(plain, 'dirty.txt'));
  const wt = await createWorktree(plain, 'Nothing To Do');
  assert.match(wt.branch, /^oasis\/nothing-to-do-/);
  const done = await finishWorktree(plain, wt);
  assert.equal(done.changed, false);
  await assert.rejects(access(wt.path));
  assert.equal(execFileSync('git', ['branch', '--list', wt.branch], { cwd: plain }).toString().trim(), '');
});
