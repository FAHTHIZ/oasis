import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationIssues, markRanSources } from '../src/turn-guards.mjs';

const state = (paths) => ({ changedPaths: new Set(paths), diffReviewedPaths: new Set(paths), diffReviewedAll: true, overwrittenPaths: new Set(), lastVerificationExitCode: null });
const NO_CHECK = /no relevant test, check/;

test('running every changed script cleanly counts as a check', () => {
  const s = state(['hello.mjs']);
  assert.match(verificationIssues(s).join('\n'), NO_CHECK);
  markRanSources(s, 'node', ['./hello.mjs'], 0);
  assert.doesNotMatch(verificationIssues(s).join('\n'), NO_CHECK);
});

test('a failing run, a different file or an unrun changed file is not enough', () => {
  const failed = state(['app.py']);
  markRanSources(failed, 'python3', ['app.py'], 1);
  assert.match(verificationIssues(failed).join('\n'), NO_CHECK);
  const partial = state(['cli.mjs', 'lib.mjs']);
  markRanSources(partial, 'node', ['cli.mjs'], 0);
  markRanSources(partial, 'node', ['other.mjs'], 0);
  assert.match(verificationIssues(partial).join('\n'), NO_CHECK);
  const deno = state(['main.ts']);
  markRanSources(deno, 'deno', ['run', '--allow-read', 'main.ts'], 0);
  assert.doesNotMatch(verificationIssues(deno).join('\n'), NO_CHECK);
});
