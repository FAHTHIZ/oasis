// Detects edits that weaken a test suite instead of fixing code: newly skipped
// or focused tests, removed test cases, and removed assertions. Runs against
// `git diff HEAD` for the files the agent changed, so pre-existing user edits
// in other files are not attributed to the agent.
import { execFile } from 'node:child_process';

const TEST_PATH = [
  /(^|\/)(tests?|__tests__|specs?|testing)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(_test|_spec)\.(go|py|rb|exs?|rs)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /(Test|Tests|Spec)\.(java|kt|scala|cs|swift|php)$/,
  // A single test script: test.mjs, tests.py, spec.js, test.sh.
  /(^|\/)(tests?|specs?)\.([cm]?[jt]sx?|py|rb|sh)$/i
];

export function isTestPath(file) {
  const normalized = String(file || '').replace(/\\/g, '/');
  return TEST_PATH.some((pattern) => pattern.test(normalized));
}

// Files that say how the tests run. A change there can make every test
// "pass" without touching a test file: `"test": "jest || true"`.
const TEST_CONFIG_PATH = /(^|\/)(package\.json|Makefile|makefile|GNUmakefile|justfile|Taskfile\.ya?ml|tox\.ini|noxfile\.py|pytest\.ini|setup\.cfg|pyproject\.toml|Cargo\.toml|\.github\/workflows\/[^/]+\.ya?ml|\.gitlab-ci\.ya?ml|\.circleci\/config\.yml|azure-pipelines\.ya?ml)$/;
export function isTestConfigPath(file) {
  return TEST_CONFIG_PATH.test(String(file || '').replace(/\\/g, '/'));
}
const TEST_RUNNER = /\b(?:test|tests|jest|vitest|mocha|ava|tap|pytest|unittest|tox|nox|go\s+test|cargo\s+(?:test|nextest)|rspec|phpunit|ctest|check)\b/i;
const NEUTERED_RUN = /\|\|\s*(?:true|:|exit\s+0|echo\b)|;\s*(?:true|exit\s+0)\s*["']?\s*,?\s*$|--passWithNoTests\b|--no-fail-on-empty\b|continue-on-error:\s*true|allow_failure:\s*true|\bset\s+\+e\b|--exitfirst=0\b|-p\s+no:\w+|--suppress-no-test-exit-code\b/;

const SKIP_PATTERNS = [
  [/\b(?:it|test|describe|context|suite)\.(?:skip|todo)\s*\(/, 'skipped a test'],
  [/\b(?:it|test|describe)\.only\s*\(|\bf(?:it|describe)\s*\(/, 'focused a test with .only (other tests stop running)'],
  [/\bx(?:it|describe|test)\s*\(/, 'skipped a test'],
  [/\{\s*skip\s*:\s*(?:true|['"`])|\btest\.fixme\s*\(/, 'skipped a test'],
  [/@pytest\.mark\.(?:skip|xfail)\b|@unittest\.skip|\bpytest\.skip\s*\(|\bself\.skipTest\s*\(/, 'skipped a test'],
  [/\bt\.Skip(?:Now|f)?\s*\(/, 'skipped a test'],
  [/#\[ignore\]/, 'ignored a test'],
  [/@(?:Disabled|Ignore)\b/, 'disabled a test'],
  [/^\s*(?:skip|pending)(?:\s+['"]|\s*\(\s*['"]|\s*$)/, 'skipped a test'],
  [/\bexcept\s*\(?[^:]*\bAssertionError\b|\bcatch\s*\(\s*\w*\s*(?::\s*AssertionError)?\s*\)\s*\{\s*\}|\.catch\s*\(\s*\(\s*\w*\s*\)\s*=>\s*(?:\{\s*\}|undefined|null)\s*\)|\brescue\s+(?:Minitest::Assertion|RSpec::Expectations::ExpectationNotMetError)\b|catch\s*\(\s*(?:AssertionError|AssertionFailedError)\b/, 'catches and ignores assertion failures']
];
const TEST_DECL = /^\s*(?:(?:it|test|specify)\s*\(|def\s+test_\w*\s*\(|func\s+Test\w*\s*\(|#\[test\]|@Test\b|fn\s+test_\w*\s*\()/;
// An exact check (equality, deep equality, match) versus one that only checks
// that a value exists or is truthy. Swapping the first for the second makes a
// failing test pass without fixing anything.
const STRICT_CHECK = /===?|!==?|\b(?:toBe|toEqual|toStrictEqual|toMatch\w*|toHaveLength|toThrow\w*|equal|equals|deepEqual|strictEqual|deepStrictEqual|assertEqual|assertEquals|assertIn|assertRaises|Equal|assert_eq|match)\b/;
const WEAK_CHECK = /\bis not None\b|\bis not null\b|\b(?:toBeDefined|toBeTruthy|not\.toBeNull|not\.toBeUndefined|assertIsNotNone|assertTrue|NotNil|NotEmpty|ok)\s*\(|!= nil\b|^\s*assert\s+\w+\s*$|assert\.ok\s*\(|\bassert\s*\(\s*\w+\s*\)/;
const ASSERTION = /\b(?:assert\w*|expect|should|t\.(?:Error|Fatal)f?|require\.\w+)\s*[(.]|^\s*assert\b/;

/** Analyze unified diff text (from `git diff -U0`). Returns [{ file, reason, line? }]. */
export function analyzeTestDiff(diffText) {
  const findings = [];
  const files = new Map();
  let current = null;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('diff --git ')) { current = null; continue; }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/^b\//, '');
      if (target === '/dev/null') continue;
      current = { file: target, added: [], removed: [], deleted: false };
      files.set(target, current);
      continue;
    }
    if (line.startsWith('--- ')) {
      const source = line.slice(4).replace(/^a\//, '');
      if (source !== '/dev/null') current = { file: source, added: [], removed: [], deleted: true, pending: true };
      continue;
    }
    if (!current) continue;
    if (current.pending) { current.pending = false; files.set(current.file, current); }
    if (line.startsWith('+') && !line.startsWith('+++')) { current.deleted = false; current.added.push(line.slice(1)); }
    else if (line.startsWith('-') && !line.startsWith('---')) current.removed.push(line.slice(1));
  }
  for (const entry of files.values()) {
    if (isTestConfigPath(entry.file)) {
      const touchesTests = [...entry.added, ...entry.removed].some((line) => TEST_RUNNER.test(line));
      const hit = entry.added.find((line) => NEUTERED_RUN.test(line) && (TEST_RUNNER.test(line) || (touchesTests && /continue-on-error|allow_failure/.test(line))));
      if (hit && !entry.removed.some((line) => NEUTERED_RUN.test(line))) findings.push({ file: entry.file, reason: 'made the test command succeed even when tests fail', line: hit.trim().slice(0, 160) });
      if (!isTestPath(entry.file)) continue;
    }
    // Inline test modules (Rust #[cfg(test)], doctest-style files) live outside
    // test paths; a hunk that touches a test declaration counts too.
    if (!isTestPath(entry.file) && ![...entry.added, ...entry.removed].some((line) => TEST_DECL.test(line) || /#\[(?:test|ignore)\]/.test(line))) continue;
    if (entry.deleted && entry.removed.length && !entry.added.length && entry.removed.some((line) => TEST_DECL.test(line))) {
      findings.push({ file: entry.file, reason: 'deleted a test file with ' + entry.removed.filter((line) => TEST_DECL.test(line)).length + ' test(s)' });
      continue;
    }
    const removedSkips = entry.removed.join('\n');
    for (const [pattern, reason] of SKIP_PATTERNS) {
      const hit = entry.added.find((line) => pattern.test(line));
      if (hit && !pattern.test(removedSkips)) { findings.push({ file: entry.file, reason, line: hit.trim().slice(0, 160) }); break; }
    }
    const declDelta = entry.removed.filter((line) => TEST_DECL.test(line)).length - entry.added.filter((line) => TEST_DECL.test(line)).length;
    if (declDelta > 0) findings.push({ file: entry.file, reason: 'removed ' + declDelta + ' test case(s)' });
    const assertDelta = entry.removed.filter((line) => ASSERTION.test(line)).length - entry.added.filter((line) => ASSERTION.test(line)).length;
    if (assertDelta > 0 && declDelta <= 0) findings.push({ file: entry.file, reason: 'removed ' + assertDelta + ' assertion(s)' });
    if (assertDelta <= 0 && declDelta <= 0) {
      const strict = (lines) => lines.filter((line) => ASSERTION.test(line) && STRICT_CHECK.test(line) && !WEAK_CHECK.test(line)).length;
      const weak = (lines) => lines.filter((line) => ASSERTION.test(line) && WEAK_CHECK.test(line)).length;
      const loosened = strict(entry.removed) - strict(entry.added);
      if (loosened > 0 && weak(entry.added) > weak(entry.removed)) findings.push({ file: entry.file, reason: 'replaced ' + loosened + ' exact assertion(s) with existence or truthiness checks' });
    }
  }
  return findings;
}

/** Check the given changed paths against HEAD. Resolves [] outside Git or when nothing is weakened. */
export function detectTestTampering(root, paths, { timeoutMs = 15000 } = {}) {
  const tests = [...new Set(paths || [])].filter((file) => isTestPath(file) || isTestConfigPath(file));
  if (!tests.length) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile('git', ['diff', '--no-color', '--no-ext-diff', '-U0', 'HEAD', '--', ...tests], { cwd: root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) return resolve([]);
      resolve(analyzeTestDiff(stdout));
    });
  });
}
