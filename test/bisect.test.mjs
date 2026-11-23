import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ambiguousFromOutput, firstBadFromOutput, runBisect } from '../src/bisect.mjs';
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));

// 12 commits; the one numbered `breakAt` makes add() wrong. A check script
// exits 1 when add(2, 2) !== 4.
function history(t, { breakAt = 7, commits = 12, sub = '', skipAt = [] } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oasis-bisect-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init', '-q');
  git('config', 'user.email', 't@example.invalid');
  git('config', 'user.name', 'T');
  const dir = path.join(root, sub);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'check.mjs'), "import { existsSync } from 'node:fs';\nimport { add } from './add.mjs';\nif (existsSync('untestable')) process.exit(125);\nprocess.exit(add(2, 2) === 4 ? 0 : 1);\n");
  const shas = [];
  for (let index = 1; index <= commits; index += 1) {
    const body = index >= breakAt ? 'export const add = (a, b) => a + b + 1;\n' : 'export const add = (a, b) => a + b;\n';
    writeFileSync(path.join(dir, 'add.mjs'), body + '// revision ' + index + '\n');
    writeFileSync(path.join(root, 'log' + index + '.txt'), String(index));
    if (skipAt.includes(index)) writeFileSync(path.join(dir, 'untestable'), '');
    else rmSync(path.join(dir, 'untestable'), { force: true });
    git('add', '.');
    git('commit', '-qm', 'commit ' + index);
    shas.push(git('rev-parse', 'HEAD'));
  }
  return { root, dir, shas, git };
}

const command = process.execPath + ' check.mjs';

test('git bisect output is read for the answer and for skip-hidden candidates', () => {
  assert.equal(firstBadFromOutput('abc1234def is the first bad commit\ncommit abc'), 'abc1234def');
  assert.equal(firstBadFromOutput('Bisecting: 3 revisions left'), '');
  const sha = 'a'.repeat(40);
  assert.deepEqual(ambiguousFromOutput("There are only 'skip'ped commits left to test.\nThe first bad commit could be any of:\n" + sha + '\n'), [sha]);
});

test('finds the commit that broke the check without touching the working folder', async (t) => {
  const { root, shas, git } = history(t);
  writeFileSync(path.join(root, 'uncommitted.txt'), 'mine');
  const headBefore = git('rev-parse', 'HEAD');
  const result = await runBisect(root, { command, good: shas[0] }, { autoApprove: true, env });
  assert.equal(result.ok, true, JSON.stringify(result, null, 1));
  assert.equal(result.first_bad_commit.sha, shas[6]);
  assert.equal(result.first_bad_commit.subject, 'commit 7');
  assert.ok(result.first_bad_commit.files.some((line) => line.endsWith('add.mjs')));
  assert.equal(result.commits_in_range, 11);
  assert.ok(result.steps.length <= 2 + Math.ceil(Math.log2(12)) + 1, 'binary search, not a linear walk: ' + result.steps.length);
  assert.equal(git('rev-parse', 'HEAD'), headBefore);
  assert.equal(readFileSync(path.join(root, 'uncommitted.txt'), 'utf8'), 'mine');
  assert.equal(git('worktree', 'list').split('\n').length, 1, 'the private worktree is removed');
  assert.equal(git('status', '--porcelain'), '?? uncommitted.txt', 'nothing else appears in git status');
  assert.deepEqual(readdirSync(path.join(root, '.oasis', 'bisect')), ['.gitignore']);
});

test('runs in the same subfolder of each commit in a monorepo', async (t) => {
  const { dir, shas } = history(t, { breakAt: 4, commits: 6, sub: 'packages/math' });
  const result = await runBisect(dir, { command, good: shas[1] }, { autoApprove: true, env });
  assert.equal(result.ok, true, JSON.stringify(result, null, 1));
  assert.equal(result.first_bad_commit.subject, 'commit 4');
});

test('a check that passes at bad points at uncommitted changes, not history', async (t) => {
  const { root, shas } = history(t, { breakAt: 99, commits: 4 });
  const result = await runBisect(root, { command, good: shas[0] }, { autoApprove: true, env });
  assert.equal(result.ok, false);
  assert.match(result.message, /uncommitted changes/);
});

test('a check that also fails at good says nothing changed between them', async (t) => {
  const { root, shas } = history(t, { breakAt: 1, commits: 4 });
  const result = await runBisect(root, { command, good: shas[0] }, { autoApprove: true, env });
  assert.equal(result.ok, false);
  assert.match(result.message, /also fails/);
});

test('exit 125 skips a commit, as git bisect run does', async (t) => {
  const { root, shas } = history(t, { breakAt: 6, commits: 9, skipAt: [3, 4] });
  const result = await runBisect(root, { command, good: shas[0] }, { autoApprove: true, env });
  assert.equal(result.ok, true, JSON.stringify(result, null, 1));
  assert.equal(result.first_bad_commit.subject, 'commit 6');
  // Skips are reported when the search had to step around one.
  if (result.steps.some((step) => step.verdict === 'skip')) assert.match(result.notes, /skipped/);
});

test('when only skipped commits separate good from bad, the candidates are listed', async (t) => {
  const { root, shas } = history(t, { breakAt: 5, commits: 6, skipAt: [2, 3, 4, 5] });
  const result = await runBisect(root, { command, good: shas[0] }, { autoApprove: true, env });
  assert.equal(result.ok, false, JSON.stringify(result, null, 1));
  assert.ok(result.candidates.length >= 2);
  assert.ok(result.candidates.some((item) => item.subject === 'commit 5'));
});

test('one approval names the range and run count; a no runs nothing', async (t) => {
  const { root, shas, git } = history(t, { commits: 5, breakAt: 3 });
  const prompts = [];
  const result = await runBisect(root, { command, good: shas[0] }, { env, approval: async (text) => { prompts.push(text); return false; } });
  assert.equal(result.approved, false);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Bisect 4 commit/);
  assert.match(prompts[0], /private worktree/);
  assert.equal(git('worktree', 'list').split('\n').length, 1);
  assert.equal(existsSync(path.join(root, '.oasis')), false);
});

test('bad revisions and unrelated histories are refused before anything runs', async (t) => {
  const { root } = history(t, { commits: 3 });
  assert.match((await runBisect(root, { command, good: 'nope' }, { autoApprove: true, env })).message, /Cannot find the good revision/);
  await assert.rejects(runBisect(root, { command, good: '--exec=x' }, { autoApprove: true, env }), /good and bad must be/);
  await assert.rejects(runBisect(root, { command: 'npm test | tee x', good: 'HEAD~1' }, { autoApprove: true, env }), /simple command line/);
});

test('bisect_regression is a registered tool that runs through executeTool', async (t) => {
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.function.name === 'bisect_regression'));
  const { root, shas } = history(t, { commits: 4, breakAt: 3 });
  const result = await executeTool('bisect_regression', { command, good: shas[0] }, { root, autoApprove: true, env });
  assert.equal(result.first_bad_commit.subject, 'commit 3');
});
