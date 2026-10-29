import test from 'node:test';
import assert from 'node:assert/strict';
import { appendLspUnavailableNotice, formatLspVerificationBlocker, verificationIssues } from '../src/agent.mjs';
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

test('a passed code check permits completion if the optional LSP server is unavailable', () => {
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
  assert.deepEqual(issues, [], 'LSP absence stays visible but does not override an independently passed check');

  const stateWithoutCheck = {
    changedPaths: new Set(['src/changed.ts']),
    diffReviewedPaths: new Set(['src/changed.ts']),
    diffReviewedAll: false,
    lastVerificationExitCode: null,
    lspVerificationByPath: new Map([['src/changed.ts', {
      status: 'unavailable', path: 'src/changed.ts', reason: 'No TypeScript language server found'
    }]])
  };
  const blocked = verificationIssues(stateWithoutCheck);
  assert.ok(blocked.some((issue) => /LSP verification unavailable/.test(issue)));
  assert.ok(blocked.some((issue) => /no relevant test/.test(issue)));
  assert.match(formatLspVerificationBlocker(blocked), /No TypeScript language server found/);
});

test('a completed task explicitly discloses unavailable LSP verification', () => {
  const text = appendLspUnavailableNotice('The project tests passed.', {
    changedPaths: new Set(['src/changed.ts']),
    lspVerificationByPath: new Map([['src/changed.ts', {
      status: 'unavailable',
      reason: 'No TypeScript language server found'
    }]])
  });
  assert.match(text, /The project tests passed/);
  assert.match(text, /LSP verification unavailable/);
  assert.match(text, /No TypeScript language server found/);
  assert.match(text, /not verified by a language server/);
  assert.doesNotMatch(appendLspUnavailableNotice('Checks passed.', {
    changedPaths: new Set(['src/changed.ts']),
    lspVerificationByPath: new Map()
  }), /LSP verification unavailable/);
});

test('/diagnostics explicitly combines LSP navigation diagnostics with project checkers', async () => {
  const handled = await runBuiltinCommand('diagnostics', 'src/changed.ts', { root: process.cwd() });
  assert.match(handled.prompt, /project-checker diagnostics tool and language-server diagnostics/i);
  assert.match(handled.prompt, /use the lsp operation "diagnostics"/i);
  assert.match(handled.prompt, /Errors, Warnings, Information, and Verification unavailable/);
  assert.match(handled.prompt, /rather than reporting a clean LSP result/i);
});

test('/fix explicitly treats unavailable or new LSP diagnostics as a blocker', async () => {
  const handled = await runBuiltinCommand('fix', 'a TypeScript type error', { root: process.cwd() });
  assert.match(handled.prompt, /automatic lspVerification/i);
  assert.match(handled.prompt, /new or unclassified diagnostic error as a blocker/i);
  assert.match(handled.prompt, /Do not claim \/fix succeeded while the LSP gate is blocked/i);
});
