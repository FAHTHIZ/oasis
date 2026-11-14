import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, chmod, rm, readFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { runEvalCommand, initBaselineRepo } from '../src/eval.mjs';

// Seen live (batch 2, 2026-11-14): the task workspace was a bare folder, so
// Aider created its own repository, reported "Git repo: .git with 0 files",
// could not see the project and asked the user for a file listing. Every
// agent now starts in a repository with the task files in one baseline commit.
test('external agents start in a git repository with the task files committed', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-git-baseline-'));
  try {
    const report = path.join(dir, 'git-state.json');
    const bin = path.join(dir, 'fake-aider');
    await writeFile(bin, '#!/usr/bin/env node\n' +
      "const { execFileSync } = require('child_process');\n" +
      "if (process.argv.includes('--version')) { console.log('aider 0.0.0'); process.exit(0); }\n" +
      "const git = (...a) => execFileSync('git', a, { encoding: 'utf8' });\n" +
      "require('fs').writeFileSync(process.env.FAKE_GIT_REPORT, JSON.stringify({ files: git('ls-files').trim().split('\\n'), status: git('status', '--porcelain'), commits: git('rev-list', '--count', 'HEAD').trim() }));\n" +
      "console.log('Tokens: 10 sent, 5 received.');\n");
    await chmod(bin, 0o755);
    const result = await runEvalCommand(['--aider', '--task', 'safe-relative-path', '--trials', '1', '--timeout-seconds', '60'], {
      autoApprove: true,
      env: { ...process.env, OASIS_AIDER_BIN: bin, FAKE_GIT_REPORT: report },
      output: { write: () => true },
      resultsDir: dir
    });
    const state = JSON.parse(await readFile(report, 'utf8'));
    assert.ok(state.files.includes('package.json') && state.files.includes('src/agent.mjs'), 'tracked: ' + state.files.join(', '));
    assert.equal(state.status, '', 'the baseline commit leaves a clean tree');
    assert.equal(state.commits, '1');
    assert.equal(result.results[0].gitBaseline, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the baseline commit ignores the user git config (signing, hooks)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-git-baseline-cfg-'));
  try {
    const home = path.join(dir, 'home');
    const workspace = path.join(dir, 'ws');
    await mkdir(home); await mkdir(workspace);
    await writeFile(path.join(home, '.gitconfig'), '[commit]\n\tgpgsign = true\n[gpg]\n\tprogram = /nonexistent/gpg\n[user]\n\tuseConfigOnly = true\n');
    await writeFile(path.join(workspace, 'a.txt'), 'a\n');
    assert.equal(await initBaselineRepo(workspace, { ...process.env, HOME: home, XDG_CONFIG_HOME: home }), true);
    assert.equal(execFileSync('git', ['log', '--format=%s'], { cwd: workspace, encoding: 'utf8' }).trim(), 'Task baseline');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
