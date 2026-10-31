import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile, unlink, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isTestPath, detectTestTampering, analyzeTestDiff } from '../src/test-tamper.mjs';
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
