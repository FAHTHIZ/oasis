import test from 'node:test';
import assert from 'node:assert/strict';
import { formatLspVerificationBlocker, verificationIssues } from '../src/agent.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';

test('new LSP errors block task completion and suppress an unverified success message', () => {
  const issues = verificationIssues({
    changedPaths: new Set(['src/changed.ts']),
    diffReviewedPaths: new Set(['src/changed.ts']),
    diffReviewedAll: false,
    lastVerificationExitCode: 0,
    lspVerificationByPath: new Map([['src/changed.ts', {
      status: 'issues',
      path: 'src/changed.ts',
      baselineKnown: false,
      newErrors: [{ severity: 'error', code: 'TS2322', message: 'Type is not assignable', line: 7 }]
    }]])
  });
  assert.ok(issues.some((issue) => /LSP reports 1 new or unclassified error/.test(issue)));
  const blocked = formatLspVerificationBlocker(issues);
  assert.match(blocked, /^Verification incomplete:/);
  assert.match(blocked, /src\/changed\.ts/);
  assert.match(blocked, /Fix or explicitly resolve/);
  assert.doesNotMatch(blocked, /successfully fixed|all checks passed/i);
});

test('LSP startup failure is a completion blocker rather than a success', () => {
  const issues = verificationIssues({
    changedPaths: new Set(['src/changed.ts']),
    diffReviewedPaths: new Set(['src/changed.ts']),
    diffReviewedAll: false,
    lastVerificationExitCode: 0,
    lspVerificationByPath: new Map([['src/changed.ts', {
      status: 'unavailable',
      path: 'src/changed.ts',
      reason: 'No TypeScript language server found'
    }]])
  });
  assert.ok(issues.some((issue) => /LSP verification unavailable/.test(issue)));
  assert.match(formatLspVerificationBlocker(issues), /No TypeScript language server found/);
});

test('/fix explicitly treats unavailable or new LSP diagnostics as a blocker', async () => {
  const handled = await runBuiltinCommand('fix', 'a TypeScript type error', { root: process.cwd() });
  assert.match(handled.prompt, /automatic lspVerification/i);
  assert.match(handled.prompt, /new or unclassified diagnostic error as a blocker/i);
  assert.match(handled.prompt, /Do not claim \/fix succeeded while the LSP gate is blocked/i);
});
