import test from 'node:test';
import assert from 'node:assert/strict';
import { isVerificationCommand as check } from '../src/agent.mjs';

// Seen live: a model fixed add.mjs, ran `node test.mjs` (passed), and the gate
// still demanded a test run, so OASIS asked for approval of the same run again.
test('project test scripts count as verification', () => {
  assert.equal(check('node', ['test.mjs']), true);
  assert.equal(check('node', ['tests/parser.test.js']), true);
  assert.equal(check('node', ['scripts/check-site.mjs']), true);
  assert.equal(check('python3', ['test_parser.py']), true);
  assert.equal(check('python', ['-u', 'tests/run.py']), true);
  assert.equal(check('bash', ['run_tests.sh']), true);
  assert.equal(check('./test.sh', []), true);
  assert.equal(check('deno', ['test']), true);
  assert.equal(check('deno', ['run', '-A', 'verify.ts']), true);
});

test('ordinary scripts and look-alikes do not', () => {
  assert.equal(check('node', ['index.mjs']), false);
  assert.equal(check('node', ['latest.mjs']), false);
  assert.equal(check('node', ['contest.js']), false);
  assert.equal(check('python3', ['app.py']), false);
  assert.equal(check('echo', ['test.mjs']), false);
  assert.equal(check('node', ['test.mjs', '--help']), false);
  assert.equal(check('bash', ['-c', 'echo test']), false);
  assert.equal(check('cat', ['test/fixture.txt']), false);
});

test('existing runners still count', () => {
  assert.equal(check('npm', ['test']), true);
  assert.equal(check('node', ['--test']), true);
  assert.equal(check('python', ['-m', 'pytest']), true);
  assert.equal(check('cargo', ['test']), true);
});

test('a failed command is summarized by its error line, not the runtime banner', async () => {
  const { failureLine, describeToolResult } = await import('../src/terminal-ui.mjs');
  const nodeCrash = 'node:assert:90\n  throw new AssertionError(obj);\n  ^\n\nAssertionError [ERR_ASSERTION]: -1 == 5\n    at file:///tmp/p/test.mjs:3:8\n    at ModuleJob.run (node:internal/modules/esm/module_job:271:25) {\n  generatedMessage: true,\n  code: \'ERR_ASSERTION\'\n}\n\nNode.js v22.20.0\n';
  assert.equal(failureLine(nodeCrash), 'AssertionError [ERR_ASSERTION]: -1 == 5');
  assert.match(describeToolResult('run_shell', { exitCode: 1, stderr: nodeCrash }, { color: false }), /✗ exit 1 · AssertionError/);
  assert.equal(failureLine('Traceback (most recent call last):\n  File "a.py", line 1\nKeyError: 1\n\nDuring handling...\nTraceback (most recent call last):\n  File "a.py", line 3\nValueError: bad input\n'), 'ValueError: bad input');
  assert.equal(failureLine('building\nsomething went sideways\n'), 'something went sideways');
});
