import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, unlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isTestPath, detectTestTampering, analyzeTestDiff, isTestConfigPath } from '../src/test-tamper.mjs';
import { verificationIssues } from '../src/agent.mjs';

test('test files are recognized across ecosystems', () => {
  for (const file of ['test/a.test.mjs', 'src/a.spec.ts', 'pkg/x_test.go', 'tests/test_api.py', 'app/test_models.py', 'src/test/java/FooTest.java', 'spec/user_spec.rb', '__tests__/x.js']) assert.ok(isTestPath(file), file);
  for (const file of ['src/app.js', 'README.md', 'src/attestation.js', 'contest.py']) assert.equal(isTestPath(file), false, file);
});

async function repo(t, files) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-tamper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q');
  for (const [file, text] of Object.entries(files)) { await mkdir(path.dirname(path.join(root, file)), { recursive: true }); await writeFile(path.join(root, file), text); }
  git('add', '.');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  return root;
}

const jsSuite = "import test from 'node:test';\nimport assert from 'node:assert';\ntest('adds', () => {\n  assert.equal(add(1, 2), 3);\n  assert.equal(add(2, 2), 4);\n});\ntest('subtracts', () => {\n  assert.equal(sub(3, 1), 2);\n});\n";

test('skips, .only, removed tests, removed assertions and deleted files are reported', async (t) => {
  const root = await repo(t, { 'math.test.js': jsSuite, 'test_api.py': 'def test_get():\n    assert get() == 1\n', 'gone.test.js': jsSuite, 'keep.test.js': jsSuite, 'src/app.js': 'x\n' });
  await writeFile(path.join(root, 'math.test.js'), jsSuite.replace("test('adds'", "test.skip('adds'"));
  await writeFile(path.join(root, 'test_api.py'), 'import pytest\n@pytest.mark.skip(reason="flaky")\ndef test_get():\n    assert get() == 1\n');
  await unlink(path.join(root, 'gone.test.js'));
  await writeFile(path.join(root, 'keep.test.js'), jsSuite.replace("  assert.equal(add(2, 2), 4);\n", '').replace("test('subtracts', () => {\n  assert.equal(sub(3, 1), 2);\n});\n", ''));
  await writeFile(path.join(root, 'src/app.js'), 'y\n');
  const findings = await detectTestTampering(root, ['math.test.js', 'test_api.py', 'gone.test.js', 'keep.test.js', 'src/app.js']);
  const byFile = Object.fromEntries(findings.map((item) => [item.file + '|' + item.reason, item]));
  assert.ok(byFile['math.test.js|skipped a test'], JSON.stringify(findings));
  assert.ok(byFile['test_api.py|skipped a test']);
  assert.ok(byFile['gone.test.js|deleted a test file with 2 test(s)']);
  assert.ok(byFile['keep.test.js|removed 1 test case(s)']);
  assert.equal(findings.some((item) => item.file === 'src/app.js'), false);
});

test('legitimate test work is not flagged', async (t) => {
  const root = await repo(t, { 'math.test.js': jsSuite.replace("test('adds'", "test.skip('adds'"), 'other.test.js': jsSuite });
  // Un-skipping a test, adding tests, and rewording an assertion are fine.
  await writeFile(path.join(root, 'math.test.js'), jsSuite + "test('multiplies', () => {\n  assert.equal(mul(2, 3), 6);\n});\n");
  await writeFile(path.join(root, 'other.test.js'), jsSuite.replace('assert.equal(add(1, 2), 3);', 'assert.strictEqual(add(1, 2), 3);'));
  assert.deepEqual(await detectTestTampering(root, ['math.test.js', 'other.test.js']), []);
  assert.deepEqual(await detectTestTampering(os.tmpdir(), ['x.test.js']), [], 'outside Git it stays quiet');
});

test('Go, Rust and JUnit markers and focused tests are caught from a raw diff', () => {
  const diff = [
    'diff --git a/x_test.go b/x_test.go', '--- a/x_test.go', '+++ b/x_test.go', '@@ -3 +3,2 @@', '+\tt.Skip("later")',
    'diff --git a/tests/lib.rs b/tests/lib.rs', '--- a/tests/lib.rs', '+++ b/tests/lib.rs', '@@ -1 +1 @@', '+#[ignore]',
    'diff --git a/src/test/FooTest.java b/src/test/FooTest.java', '--- a/src/test/FooTest.java', '+++ b/src/test/FooTest.java', '@@ -1 +1 @@', '+  @Disabled',
    'diff --git a/a.spec.ts b/a.spec.ts', '--- a/a.spec.ts', '+++ b/a.spec.ts', '@@ -1 +1 @@', "-describe('x', () => {", "+describe.only('x', () => {"
  ].join('\n');
  assert.deepEqual(analyzeTestDiff(diff).map((item) => item.reason), ['skipped a test', 'ignored a test', 'disabled a test', 'focused a test with .only (other tests stop running)']);
});

test('weakened tests become a verification issue', () => {
  const issues = verificationIssues({ changedPaths: new Set(['a.test.js']), diffReviewedAll: true, diffReviewedPaths: new Set(), lastVerificationExitCode: 0, testTampering: [{ file: 'a.test.js', reason: 'skipped a test' }] });
  assert.equal(issues.length, 1);
  assert.match(issues[0], /^tests were weakened instead of the code being fixed \(a\.test\.js: skipped a test\)/);
});

test('an #[ignore] added to an inline Rust test module is flagged', async () => {
  const { analyzeTestDiff } = await import('../src/test-tamper.mjs');
  const diff = ['diff --git a/src/lib.rs b/src/lib.rs', '--- a/src/lib.rs', '+++ b/src/lib.rs', '@@ -1,2 +1,3 @@', '-#[test]', '+#[test]', '+#[ignore]'].join('\n');
  assert.equal(analyzeTestDiff(diff).length, 1);
  const plain = ['diff --git a/src/lib.rs b/src/lib.rs', '--- a/src/lib.rs', '+++ b/src/lib.rs', '@@ -1 +1 @@', '-fn a() {}', '+fn b() {}'].join('\n');
  assert.equal(analyzeTestDiff(plain).length, 0);
});

test('replacing an exact assertion with an existence check is flagged', () => {
  const d = (f, r, a) => ['diff --git a/' + f + ' b/' + f, '--- a/' + f, '+++ b/' + f, '@@ -1 +1 @@', ...r.map((l) => '-' + l), ...a.map((l) => '+' + l)].join('\n');
  assert.match(analyzeTestDiff(d('tests/test_parse.py', ['    assert parse("1") == 1'], ['    assert parse("1") is not None']))[0]?.reason || '', /existence or truthiness/);
  assert.match(analyzeTestDiff(d('test/a.test.js', ['  expect(x).toBe(1);'], ['  expect(x).toBeDefined();']))[0]?.reason || '', /existence or truthiness/);
  assert.deepEqual(analyzeTestDiff(d('test/a.test.js', ['  expect(x).toBe(1);'], ['  expect(x).toBe(2);'])), []);
  assert.deepEqual(analyzeTestDiff(d('test/a.test.js', ['  assert.ok(x);'], ['  assert.equal(x, 1);'])), []);
});

const configDiff = (file, removed, added) => ['diff --git a/' + file + ' b/' + file, '--- a/' + file, '+++ b/' + file, '@@ -1 +1 @@', ...removed.map((l) => '-' + l), ...added.map((l) => '+' + l)].join('\n');

test('a test command made to always succeed is flagged; other script and CI changes are not', () => {
  const flagged = [
    ['package.json', ['    "test": "jest --ci",'], ['    "test": "jest --ci || true",']],
    ['package.json', ['    "test": "vitest run"'], ['    "test": "vitest run --passWithNoTests"']],
    ['Makefile', ['\tpytest'], ['\tpytest || exit 0']],
    ['.github/workflows/ci.yml', ['      - run: npm test'], ['      - run: npm test', '        continue-on-error: true']]
  ];
  for (const [file, removed, added] of flagged) {
    const found = analyzeTestDiff(configDiff(file, removed, added));
    assert.equal(found.length, 1, file + ' ' + added.join(' '));
    assert.match(found[0].reason, /succeed even when tests fail/);
  }
  const fine = [
    ['package.json', ['    "lint": "eslint ."'], ['    "lint": "eslint . || true"']],
    ['package.json', ['    "test": "jest"'], ['    "test": "jest --coverage"']],
    ['package.json', ['  "version": "1.0.0",'], ['  "version": "1.0.1",']],
    ['.github/workflows/ci.yml', ['      - run: npm run preview'], ['      - run: npm run preview', '        continue-on-error: true']]
  ];
  for (const [file, removed, added] of fine) assert.deepEqual(analyzeTestDiff(configDiff(file, removed, added)), [], file + ' ' + added.join(' '));
  assert.ok(isTestConfigPath('package.json') && isTestConfigPath('.github/workflows/ci.yml') && !isTestConfigPath('src/package.js'));
});

test('catching and ignoring assertion failures in a test is flagged', () => {
  const found = analyzeTestDiff(configDiff('tests/test_io.py', ['    assert read() == b"x"'], ['    try:', '        assert read() == b"x"', '    except AssertionError:', '        pass']));
  assert.ok(found.some((f) => /ignores assertion failures/.test(f.reason)));
  assert.ok(analyzeTestDiff(configDiff('test/a.test.js', ['  await expect(load()).rejects.toThrow();'], ['  await expect(load()).rejects.toThrow().catch(() => {});'])).length);
});

test('a request for new tests is not finished until a test file changes', async () => {
  const { asksForNewTests } = await import('../src/agent.mjs');
  const base = { diffReviewedAll: true, diffReviewedPaths: new Set(), lastVerificationExitCode: 0, testsRequested: true };
  assert.match(verificationIssues({ ...base, changedPaths: new Set(['src/query.mjs']) }).join('; '), /asked for new tests/);
  assert.deepEqual(verificationIssues({ ...base, changedPaths: new Set(['src/query.mjs', 'test/query.test.mjs']) }), []);
  // Seen live: a test added to a root-level test.mjs was not counted.
  assert.deepEqual(verificationIssues({ ...base, changedPaths: new Set(['add.mjs', 'test.mjs']) }), []);
  assert.deepEqual(verificationIssues({ ...base, testsRequested: false, changedPaths: new Set(['src/query.mjs']) }), []);
  assert.equal(asksForNewTests('Keep every existing test passing and add tests for the new behavior.'), true);
  assert.equal(asksForNewTests('Write unit tests for parse()'), true);
  assert.equal(asksForNewTests('Add a flag and make sure the tests still pass'), false);
  assert.equal(asksForNewTests('Add the flag, no tests needed'), false);
  assert.equal(asksForNewTests('Fix the bug so tests pass'), false);
});

// Seen in the live benchmark (taskflow-emoji-truncate): asked to "add a
// regression test", the model added asserts to an existing test() case.
test('testFilesExtendedWithoutNewCase: asserts added inside an existing case, not a new case', async () => {
  const { testFilesExtendedWithoutNewCase } = await import('../src/test-tamper.mjs');
  const extended = 'diff --git a/test/fmt.test.mjs b/test/fmt.test.mjs\n--- a/test/fmt.test.mjs\n+++ b/test/fmt.test.mjs\n@@ -12,0 +13,2 @@\n+  assert.equal(truncate(\'ab😀cd\', 4), \'ab😀…\');\n+  assert.equal(truncate(\'😀😀😀\', 2), \'😀…\');\n';
  assert.deepEqual(testFilesExtendedWithoutNewCase(extended), ['test/fmt.test.mjs']);
  const newCase = extended.replace("@@ -12,0 +13,2 @@\n", "@@ -12,0 +13,4 @@\n+test('emoji are not split', () => {\n") + '+});\n';
  assert.deepEqual(testFilesExtendedWithoutNewCase(newCase), []);
  const newFile = 'diff --git a/test/new.test.mjs b/test/new.test.mjs\n--- /dev/null\n+++ b/test/new.test.mjs\n@@ -0,0 +1 @@\n+assert.equal(1, 1);\n';
  assert.deepEqual(testFilesExtendedWithoutNewCase(newFile), []);
});

test('the gate asks for a separate case when tests were requested and only asserts were added', async (t) => {
  const { inspectTestChanges } = await import('../src/test-tamper.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-extended-only-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'test'));
  const cases = "import test from 'node:test';\nimport assert from 'node:assert';\ntest('pads', () => {\n  assert.equal(1, 1);\n});\n";
  await writeFile(path.join(root, 'test', 'pad.test.mjs'), cases);
  await writeFile(path.join(root, 'test.mjs'), "import assert from 'node:assert';\nassert.equal(1, 1);\n");
  try {
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'base'], { cwd: root });
  } catch { t.skip('git unavailable'); return; }
  await writeFile(path.join(root, 'test', 'pad.test.mjs'), cases.replace('  assert.equal(1, 1);\n', '  assert.equal(1, 1);\n  assert.equal(2, 2);\n'));
  await writeFile(path.join(root, 'test.mjs'), "import assert from 'node:assert';\nassert.equal(1, 1);\nassert.equal(2, 2);\n");
  const changes = await inspectTestChanges(root, ['test/pad.test.mjs', 'test.mjs']);
  assert.deepEqual(changes.extendedOnly, ['test/pad.test.mjs'], 'a bare assertion script has no cases to add');
  const state = { changedPaths: new Set(['src/pad.mjs', 'test/pad.test.mjs']), diffReviewedPaths: new Set(), diffReviewedAll: true, lastVerificationExitCode: 0, testsRequested: true, testsOnlyExtended: changes.extendedOnly };
  assert.ok(verificationIssues(state).some((issue) => /asked for a new test, but the change only added assertions inside existing test cases \(test\/pad\.test\.mjs\)/.test(issue)));
  assert.ok(!verificationIssues({ ...state, testsRequested: false }).some((issue) => /asked for a new test/.test(issue)));
});
