// Detects edits that weaken a test suite instead of fixing code: newly skipped
// or focused tests, removed test cases, and removed assertions. Runs against
// `git diff HEAD` for the files the agent changed, so pre-existing user edits
// in other files are not attributed to the agent.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

const TEST_PATH = [
  /(^|\/)(tests?|__tests__|specs?|testing)\//i,
  /\.(test|spec)\.[cm]?[jt]sx?$/i,
  /(_test|_spec)\.(go|py|rb|exs?|rs)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /(Test|Tests|Spec)\.(java|kt|scala|cs|swift|php)$/,
  // A single test script: test.mjs, tests.py, spec.js, test.sh.
  /(^|\/)(tests?|specs?)\.([cm]?[jt]sx?|py|rb|sh)$/i,
  // Test setup that runs inside every test: pytest's conftest.py and the
  // Jest/Vitest setup files. A hook there can rewrite every outcome.
  /(^|\/)conftest\.py$/,
  /(^|\/)(setupTests|(jest|vitest)\.setup)\.[cm]?[jt]sx?$/
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
  [/\bpytest_runtest_makereport\b|\bitems\[:\]\s*=|\bitems\.(?:clear|remove|pop)\(|\bpytest_deselected\b|\.outcome\s*=\s*['"]passed['"]/, 'changed how pytest collects or reports tests'],
  [/(?:^|[^\w.])(?:assert|expect)(?:\.\w+)*\s*=(?![=>])|Object\.defineProperty\(\s*assert\b|\bmock\.patch\(\s*['"](?:unittest\.)?assert/, 'replaced the assertion functions'],
  [/\bprocess\.exit\s*\(\s*0?\s*\)|\bprocess\.exitCode\s*=\s*0\b|\bos\._exit\(\s*0\s*\)|\bprocess\.reallyExit\b/, 'forces a zero exit code from the tests'],
  [/\bexcept\s*\(?[^:]*\bAssertionError\b|\bcatch\s*\(\s*\w*\s*(?::\s*AssertionError)?\s*\)\s*\{\s*\}|\.catch\s*\(\s*\(\s*\w*\s*\)\s*=>\s*(?:\{\s*\}|undefined|null)\s*\)|\brescue\s+(?:Minitest::Assertion|RSpec::Expectations::ExpectationNotMetError)\b|catch\s*\(\s*(?:AssertionError|AssertionFailedError)\b/, 'catches and ignores assertion failures']
];
const TEST_DECL = /^\s*(?:(?:it|test|specify)(?:\.(?:skip|only|todo|fixme))?\s*\(|def\s+test_\w*\s*\(|func\s+Test\w*\s*\(|#\[test\]|@Test\b|fn\s+test_\w*\s*\()/;
// An exact check (equality, deep equality, match) versus one that only checks
// that a value exists or is truthy. Swapping the first for the second makes a
// failing test pass without fixing anything.
const STRICT_CHECK = /===?|!==?|\b(?:toBe|toEqual|toStrictEqual|toMatch\w*|toHaveLength|toThrow\w*|equal|equals|deepEqual|strictEqual|deepStrictEqual|assertEqual|assertEquals|assertIn|assertRaises|Equal|assert_eq|match)\b/;
const WEAK_CHECK = /\bis not None\b|\bis not null\b|\b(?:toBeDefined|toBeTruthy|not\.toBeNull|not\.toBeUndefined|assertIsNotNone|assertTrue|NotNil|NotEmpty|ok)\s*\(|!= nil\b|^\s*assert\s+\w+\s*$|assert\.ok\s*\(|\bassert\s*\(\s*\w+\s*\)/;
const ASSERTION = /\b(?:assert\w*|expect|should|t\.(?:Error|Fatal)f?|require\.\w+)\s*[(.]|^\s*assert\b/;

// package.json "test" scripts and pytest addopts. Replacing `node --test`
// with `echo ok`, or adding `-k fast`, makes the suite "pass" without
// running the failing tests, and no test file changes.
const SCRIPT_LINE = /^\s*"(test(?::[\w:.-]+)?)"\s*:\s*"((?:[^"\\]|\\.)*)"/;
const ADDOPTS_LINE = /^\s*addopts\s*=\s*(.*)$/;
const CANNOT_FAIL = /^\s*(?:true|:|exit\s+0|echo\b[^&|;]*|printf\b[^&|;]*|node\s+-e\s+(?:["']?(?:0|""|''|process\.exit\(0\))["']?)?)\s*;?\s*$/;
const NARROWING = /(?:^|\s)(?:-k|--grep|-g|--fgrep|--test-name-pattern|--testNamePattern|-t|--test-only|--test-skip-pattern|--deselect|--ignore|--ignore-glob|--testPathIgnorePatterns|--skip|--exclude|-run)(?:[=\s]|$)/;
function testScriptChanges(entry) {
  const findings = [];
  const scripts = (lines) => new Map(lines.map((line) => line.match(SCRIPT_LINE)).filter(Boolean).map((match) => [match[1], match[2]]));
  const before = scripts(entry.removed);
  const after = scripts(entry.added);
  for (const [key, value] of before) {
    if (CANNOT_FAIL.test(value)) continue;
    const next = after.get(key);
    if (next === undefined) {
      // -U0 shows a moved line as removed and added; only a key gone from the added side is a removal.
      if (!entry.added.some((line) => line.includes('"' + key + '"'))) findings.push({ file: entry.file, reason: 'removed the "' + key + '" script' });
    } else if (CANNOT_FAIL.test(next)) findings.push({ file: entry.file, reason: 'replaced the test command with one that cannot fail', line: ('"' + key + '": "' + next + '"').slice(0, 160) });
    else if (NARROWING.test(next) && !NARROWING.test(value)) findings.push({ file: entry.file, reason: 'narrowed the test command to some tests', line: ('"' + key + '": "' + next + '"').slice(0, 160) });
  }
  const addopts = (lines) => lines.map((line) => line.match(ADDOPTS_LINE)).filter(Boolean).map((match) => match[1]);
  const optsBefore = addopts(entry.removed).join(' ');
  const narrowed = addopts(entry.added).find((value) => NARROWING.test(value) || /(?:^|\s)-m\s/.test(value));
  if (narrowed && !NARROWING.test(optsBefore) && !/(?:^|\s)-m\s/.test(optsBefore)) findings.push({ file: entry.file, reason: 'narrowed the test command to some tests', line: ('addopts = ' + narrowed).slice(0, 160) });
  return findings;
}

// The user asked for the tests themselves to change ("update the tests",
// "the expected value is wrong"); "fix the failing tests" means the code.
const TESTS_ARE_THE_TASK = /\b(?:update|change|adjust|rewrite|edit|regenerate|correct)\b[^.\n]{0,40}\b(?:tests?|specs?)\b|\b(?:fix|update|correct|change|adjust)\b[^.\n]{0,40}\b(?:expected|expectations?|assertions?|snapshots?|fixtures?)\b|\b(?:tests?|expected values?|expectations?|assertions?)\b[^\n]{0,40}?\b(?:is|are) (?:wrong|outdated|incorrect|stale)\b/i;

export function requestTargetsTests(request) {
  return TESTS_ARE_THE_TASK.test(String(request || ''));
}

// An assertion with its literals blanked: `assert.equal(median([3, 1, 2]), 2)`
// and the same line ending in `3)` have one shape.
function assertionShape(line) {
  return String(line).replace(/(["'`])(?:\\.|(?!\1).)*\1/g, 'L').replace(/-?\b\d+(?:\.\d+)?(?:e[+-]?\d+)?\b/gi, 'L').replace(/\b(?:true|false|True|False|null|None|nil|undefined)\b/g, 'L').replace(/\s+/g, '');
}

/**
 * Analyze unified diff text (from `git diff -U0`). Returns [{ file, reason, line? }].
 * `codeChanged` says whether anything outside the tests changed; by default it
 * is read from the diff. When nothing did, an assertion whose expected values
 * were rewritten was made to agree with the code instead of the code fixed.
 */
export function analyzeTestDiff(diffText, { codeChanged } = {}) {
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
  const outsideTests = codeChanged !== undefined ? Boolean(codeChanged) : [...files.values()].some((entry) => !isTestPath(entry.file) && !isTestConfigPath(entry.file) && (entry.added.length || entry.removed.length));
  for (const entry of files.values()) {
    if (isTestConfigPath(entry.file)) {
      const touchesTests = [...entry.added, ...entry.removed].some((line) => TEST_RUNNER.test(line));
      const hit = entry.added.find((line) => NEUTERED_RUN.test(line) && (TEST_RUNNER.test(line) || (touchesTests && /continue-on-error|allow_failure/.test(line))));
      if (hit && !entry.removed.some((line) => NEUTERED_RUN.test(line))) findings.push({ file: entry.file, reason: 'made the test command succeed even when tests fail', line: hit.trim().slice(0, 160) });
      else findings.push(...testScriptChanges(entry));
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
    if (!outsideTests && assertDelta <= 0 && declDelta <= 0) {
      const removedShapes = new Map();
      for (const line of entry.removed) if (ASSERTION.test(line)) removedShapes.set(assertionShape(line), line.trim());
      const rewritten = entry.added.filter((line) => ASSERTION.test(line) && removedShapes.has(assertionShape(line)) && removedShapes.get(assertionShape(line)) !== line.trim());
      if (rewritten.length) findings.push({ file: entry.file, reason: 'changed the expected values in ' + rewritten.length + ' assertion(s) while no code outside the tests changed', line: rewritten[0].trim().slice(0, 160), expectation: true });
    }
  }
  return findings;
}

/**
 * Tracked test files whose diff added assertions but no test case. Seen in a
 * live benchmark: asked to "add a regression test", the model put two asserts
 * into an existing test(); the fix was right but no test reports on it alone.
 */
export function testFilesExtendedWithoutNewCase(diffText) {
  const files = new Map();
  let current = null;
  for (const line of String(diffText || '').split('\n')) {
    if (line.startsWith('diff --git ')) { current = null; continue; }
    if (line.startsWith('--- ')) { if (line.slice(4) === '/dev/null') current = 'new'; continue; }
    if (line.startsWith('+++ ')) {
      const target = line.slice(4).replace(/^b\//, '');
      current = current === 'new' || target === '/dev/null' || !isTestPath(target) ? null : files.get(target) || { added: 0, cases: 0 };
      if (current) files.set(target, current);
      continue;
    }
    if (!current || typeof current !== 'object') continue;
    if (line.startsWith('+')) {
      if (TEST_DECL.test(line.slice(1))) current.cases++;
      else if (ASSERTION.test(line.slice(1))) current.added++;
    } else if (line.startsWith('-') && TEST_DECL.test(line.slice(1))) current.cases--;
  }
  const entries = [...files.entries()];
  if (!entries.length || entries.some(([, entry]) => entry.cases > 0)) return [];
  return entries.filter(([, entry]) => entry.added > 0).map(([file]) => file);
}

function gitTestDiff(root, paths, timeoutMs) {
  const tests = [...new Set(paths || [])].filter((file) => isTestPath(file) || isTestConfigPath(file));
  if (!tests.length) return Promise.resolve('');
  return new Promise((resolve) => {
    execFile('git', ['diff', '--no-color', '--no-ext-diff', '-U0', 'HEAD', '--', ...tests], { cwd: root, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout) => resolve(error ? '' : stdout));
  });
}

/**
 * Tracked test files and test configs that differ from HEAD, with a hash of
 * their current contents. Shell commands (sed -i, git rm, echo >) change files
 * without the edit tools seeing it; comparing a snapshot from the start of the
 * turn with one at the end finds the test files a command touched, so they
 * get the same tamper check as edits. Resolves an empty map outside Git.
 */
export function testFileSnapshot(root, { timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    execFile('git', ['diff', '--name-only', '--no-renames', 'HEAD'], { cwd: root, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, async (error, stdout) => {
      const snapshot = new Map();
      if (error) { resolve(snapshot); return; }
      for (const file of String(stdout).split('\n').map((line) => line.trim()).filter(Boolean)) {
        if (!isTestPath(file) && !isTestConfigPath(file)) continue;
        try { snapshot.set(file, createHash('sha1').update(await readFile(path.resolve(root, file))).digest('hex')); } catch { snapshot.set(file, 'deleted'); }
      }
      resolve(snapshot);
    });
  });
}

/** Paths whose snapshot entry changed between `before` and `after`. */
export function snapshotChanges(before, after) {
  const changed = [];
  for (const [file, hash] of after) if (!before || before.get(file) !== hash) changed.push(file);
  if (before) for (const file of before.keys()) if (!after.has(file)) changed.push(file);
  return changed;
}

/** Check the given changed paths against HEAD. Resolves [] outside Git or when nothing is weakened. */
export async function detectTestTampering(root, paths, { timeoutMs = 15000, codeChanged = true } = {}) {
  return analyzeTestDiff(await gitTestDiff(root, paths, timeoutMs), { codeChanged });
}

/** One git diff for both checks: weakened tests and tests extended without a new case. */
export async function inspectTestChanges(root, paths, { timeoutMs = 15000, codeChanged = true } = {}) {
  const diff = await gitTestDiff(root, paths, timeoutMs);
  // A plain assertion script (test.mjs with bare asserts) has no cases to add.
  const extendedOnly = [];
  for (const file of testFilesExtendedWithoutNewCase(diff)) {
    try { if (String(await readFile(path.resolve(root, file), 'utf8')).split('\n').some((line) => TEST_DECL.test(line))) extendedOnly.push(file); } catch {}
  }
  return { tampering: analyzeTestDiff(diff, { codeChanged }), extendedOnly };
}
