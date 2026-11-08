// What the agent has verified this task: diff review, test and build runs,
// LSP diagnostics, and the issues that block a success claim.
import { isTestPath } from './test-tamper.mjs';
import path from 'node:path';
import { SOURCE_EXTENSIONS, VERIFICATION_RUNNERS, diffReviewComplete, executableName, verificationIssues } from './turn-guards.mjs';

export function formatLspVerificationBlocker(issues) {
  const blockers = (Array.isArray(issues) ? issues : []).filter((issue) =>
    issue.startsWith('LSP verification unavailable') || issue.startsWith('LSP reports ')
  );
  if (!blockers.length) return null;
  return 'Verification incomplete: Oasis did not mark this change as successful because the LSP gate remains blocked.\n' +
    blockers.map((issue) => '- ' + issue).join('\n') +
    '\nFix or explicitly resolve these diagnostics, then run verification again.';
}


export { verificationCommandKind as verificationCommandKindForTest };
export function verificationCommandKind(command, args) {
  const executable = executableName(command);
  const argv = (Array.isArray(args) ? args : []).map((item) => String(item || '').toLowerCase());
  const taskTokens = [argv[0], argv[0] === 'run' ? argv[1] : '', argv[0] === 'exec' || argv[0] === 'x' || argv[0] === 'dlx'
    ? argv.slice(1).find((item) => VERIFICATION_RUNNERS.has(executableName(item))) || ''
    : ''].filter(Boolean);
  const testRunners = new Set(['pytest', 'vitest', 'jest', 'mocha', 'tap', 'ava', 'phpunit']);
  const lintRunners = new Set(['eslint', 'prettier', 'ruff', 'flake8', 'stylelint', 'shellcheck', 'golangci-lint', 'swiftlint']);
  const typeCheckRunners = new Set(['tsc', 'pyright', 'mypy', 'phpstan']);
  // `node test.mjs`, `python tests.py`, `bash test.sh`: running a test file is a test run.
  const runsTestFile = argv.some((item) => !item.startsWith('-') && isTestPath(item));
  if (argv.includes('--test') || runsTestFile || testRunners.has(executable) || argv.some((item) => testRunners.has(executableName(item))) ||
      taskTokens.some((item) => item === 'test' || item === 'tests' || item.startsWith('test:'))) return 'test';
  if (lintRunners.has(executable) || argv.some((item) => lintRunners.has(executableName(item))) ||
      taskTokens.some((item) => item === 'lint' || item.startsWith('lint:'))) return 'lint';
  if (typeCheckRunners.has(executable) || argv.some((item) => typeCheckRunners.has(executableName(item))) ||
      taskTokens.some((item) => ['typecheck', 'type-check', 'types'].includes(item))) return 'type-check';
  if (taskTokens.some((item) => ['build', 'compile', 'compileall', 'package', 'verify'].includes(item))) return 'build';
  return 'check';
}

export function verificationSummary(state) {
  const changedPaths = [...state.changedPaths];
  const diffReviewed = diffReviewComplete(state);
  const checkRequired = changedPaths.some((item) => SOURCE_EXTENSIONS.has(path.extname(item).toLowerCase()));
  const lastCheck = state.lastVerificationKind
    ? {
        kind: state.lastVerificationKind,
        exitCode: Number.isInteger(state.lastVerificationExitCode) ? state.lastVerificationExitCode : null,
        passed: state.lastVerificationExitCode === 0
      }
    : null;
  const lsp = [...(state.lspVerificationByPath || new Map()).entries()]
    .filter(([file]) => changedPaths.includes(file))
    .map(([file, result]) => ({
      path: file,
      status: result && result.status === 'unavailable'
        ? 'unavailable'
        : result && result.status === 'not_applicable'
          ? 'not_applicable'
          : result && Array.isArray(result.newErrors) && result.newErrors.length
            ? 'errors'
            : result && (result.status === 'warnings' || Array.isArray(result.newWarnings) && result.newWarnings.length)
              ? 'warnings'
              : 'clean',
      ...(result && result.status === 'unavailable' ? { blocking: result.blocking !== false } : {}),
      newErrorCount: result && Array.isArray(result.newErrors) ? result.newErrors.length : 0,
      newWarningCount: result && Array.isArray(result.newWarnings) ? result.newWarnings.length : 0,
      ...(result && result.reason ? { reason: String(result.reason).replace(/[\r\n\0]/g, ' ').slice(0, 240) } : {})
    }));
  const issues = verificationIssues(state);
  return {
    required: changedPaths.length > 0,
    changedPaths,
    diffReviewed,
    checkRequired,
    lastCheck,
    lsp,
    ...(state.autoTestLast ? { autoTest: state.autoTestLast } : {}),
    ...(Array.isArray(state.testTampering) && state.testTampering.length ? { testTampering: state.testTampering } : {}),
    complete: issues.length === 0,
    issues
  };
}
