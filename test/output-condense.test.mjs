import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { condenseOutput, createOutputCondenser, condenseOutputEnabled } from '../src/output-condense.mjs';
import { runWorkspaceCommand } from '../src/tools.mjs';

const PASSING = [
  'TAP version 13',
  '# Subtest: adds numbers',
  'ok 1 - adds numbers',
  '  ---',
  '  duration_ms: 0.81',
  "  type: 'test'",
  '  ...',
  '# Subtest: suite',
  '    # Subtest: inner',
  '    ok 1 - inner',
  '      ---',
  '      duration_ms: 0.2',
  '      ...',
  '    1..1',
  'ok 2 - suite',
  '  ---',
  '  duration_ms: 1.5',
  "  type: 'suite'",
  '  ...',
  '1..2',
  '# pass 2',
  '# fail 0',
  ''
].join('\n');

test('passing node --test output keeps one line per test and the summary', () => {
  const { text, removed } = condenseOutput(PASSING);
  assert.equal(text, [
    'TAP version 13',
    'ok 1 - adds numbers',
    '# Subtest: suite',
    '    ok 1 - inner',
    '    1..1',
    'ok 2 - suite',
    '1..2',
    '# pass 2',
    '# fail 0',
    ''
  ].join('\n'));
  assert.equal(removed, 13);
});

test('a failing test keeps its header and every diagnostic line', () => {
  const failing = [
    '# Subtest: breaks',
    'not ok 1 - breaks',
    '  ---',
    '  duration_ms: 0.9',
    "  type: 'test'",
    "  location: '/w/test/a.test.mjs:3:1'",
    "  failureType: 'testCodeFailure'",
    '  error: |-',
    '    Expected values to be strictly equal:',
    '    1 !== 2',
    '  ...',
    ''
  ].join('\n');
  assert.deepEqual(condenseOutput(failing), { text: failing, removed: 0, redraws: 0 });
  // A passing test whose YAML says more than timing (a skip reason, a diagnostic) keeps it.
  const noted = '# Subtest: x\nok 1 - x # SKIP not on this OS\n  ---\n  duration_ms: 0.1\n  skip: not on this OS\n  ...\n';
  assert.equal(condenseOutput(noted).text, 'ok 1 - x # SKIP not on this OS\n  ---\n  duration_ms: 0.1\n  skip: not on this OS\n  ...\n');
  // A header followed by something other than its own ok line stays.
  assert.equal(condenseOutput('# Subtest: a\nok 1 - b\n').text, '# Subtest: a\nok 1 - b\n');
});

test('npm update banners go; other npm notices stay', () => {
  const banner = 'npm notice\nnpm notice New major version of npm available! 10.9.4 -> 12.2.2\nnpm notice Changelog: https://github.com/npm/cli/releases/tag/v12.2.2\nnpm notice To update run: npm install -g npm@12.2.2\nnpm notice\n';
  assert.deepEqual(condenseOutput(banner), { text: '', removed: 5, redraws: 0 });
  const publish = 'npm notice\nnpm notice package: demo@1.0.0\nnpm notice Tarball Contents\nnpm notice\n';
  assert.equal(condenseOutput(publish).text, publish);
  assert.equal(condenseOutput('real warning\n' + banner + 'after\n').text, 'real warning\nafter\n');
});

test('go test -v drops RUN lines of tests that pass at once, keeps the rest', () => {
  const out = '=== RUN   TestAdd\n--- PASS: TestAdd (0.00s)\n=== RUN   TestSlow\n    slow_test.go:9: still going\n--- FAIL: TestSlow (1.20s)\nFAIL\n';
  assert.equal(condenseOutput(out).text, '--- PASS: TestAdd (0.00s)\n=== RUN   TestSlow\n    slow_test.go:9: still going\n--- FAIL: TestSlow (1.20s)\nFAIL\n');
});

test('progress redraws keep their final frame; CRLF output is untouched', () => {
  const { text, redraws } = condenseOutput('Downloading  10%\rDownloading  55%\rDownloading 100%\ndone\r\nnext\r\n');
  assert.equal(text, 'Downloading 100%\ndone\r\nnext\r\n');
  assert.equal(redraws, 1);
});

test('the streaming condenser handles lines and UTF-8 split across chunks', () => {
  const condenser = createOutputCondenser();
  const bytes = Buffer.from('# Subtest: café ✓\nok 1 - café ✓\n  ---\n  duration_ms: 1\n  ...\ntail ✓');
  let text = '';
  for (let i = 0; i < bytes.length; i += 3) text += condenser.push(bytes.subarray(i, i + 3));
  text += condenser.end();
  assert.equal(text, 'ok 1 - café ✓\ntail ✓');
  assert.equal(condenser.removed, 4);
});

test('OASIS_CONDENSE_OUTPUT=0 turns it off', () => {
  assert.equal(condenseOutputEnabled({}), true);
  assert.equal(condenseOutputEnabled({ OASIS_CONDENSE_OUTPUT: '0' }), false);
  assert.equal(condenseOutputEnabled({ OASIS_CONDENSE_OUTPUT: 'off' }), false);
});

test('run_command condenses a real node --test run and keeps the raw log', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-condense-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'a.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\n" +
    Array.from({ length: 12 }, (_, i) => "test('passes " + i + "', () => {});\n").join('') +
    "test('breaks', () => { assert.equal(1, 2); });\n");
  const env = { ...process.env, NODE_OPTIONS: '' };
  delete env.OASIS_CONDENSE_OUTPUT;
  delete env.NODE_TEST_CONTEXT;
  const result = await runWorkspaceCommand(root, process.execPath, ['--test', '--test-reporter=tap', 'a.test.mjs'], { autoApprove: true, env });
  assert.equal(result.exitCode, 1);
  assert.match(result.stdout, /^ok 1 - passes 0$/m);
  assert.doesNotMatch(result.stdout, /# Subtest: passes 0/);
  assert.match(result.stdout, /# Subtest: breaks\nnot ok 13 - breaks\n {2}---\n {2}duration_ms/);
  assert.match(result.stdout, /1 !== 2/);
  assert.match(result.outputCondensed, /^Left out \d+ lines of passing-test timing.*the full output is in \.oasis\/command-logs\/.*\.stdout\.log\.$/);
  const raw = await readFile(path.join(root, result.stdoutLogPath), 'utf8');
  assert.match(raw, /# Subtest: passes 0\nok 1 - passes 0\n {2}---\n {2}duration_ms/);

  const plain = await runWorkspaceCommand(root, process.execPath, ['--test', '--test-reporter=tap', 'a.test.mjs'], { autoApprove: true, env: { ...env, OASIS_CONDENSE_OUTPUT: '0' } });
  assert.match(plain.stdout, /# Subtest: passes 0/);
  assert.equal(plain.outputCondensed, undefined);
  assert.ok(result.stdout.length < plain.stdout.length * 0.6, result.stdout.length + ' vs ' + plain.stdout.length);
});

test('command logs stay out of git status', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-condense-git-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { execFileSync } = await import('node:child_process');
  execFileSync('git', ['init', '-q'], { cwd: root });
  await writeFile(path.join(root, 'banner.mjs'), "console.log('npm notice'); console.log('npm notice New major version of npm available! 1 -> 2');\n");
  execFileSync('git', ['add', 'banner.mjs'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init'], { cwd: root });
  const result = await runWorkspaceCommand(root, process.execPath, ['banner.mjs'], { autoApprove: true, env: { ...process.env, OASIS_CONDENSE_OUTPUT: '' } });
  assert.equal(result.stdout, '');
  assert.ok(result.stdoutLogPath, 'condensed output keeps its log');
  assert.equal(execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' }), '');
});
