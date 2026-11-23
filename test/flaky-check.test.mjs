import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyRuns, normalizeFailure, runFlakyCheck } from '../src/flaky-check.mjs';
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));

function workspace(t, script) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oasis-flaky-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(path.join(root, 'check.mjs'), script);
  return root;
}

const command = process.execPath + ' check.mjs';

// Fails on every second run, using a counter file, so "flaky" is certain.
const ALTERNATING = "import { existsSync, readFileSync, writeFileSync } from 'node:fs';\n"
  + "const n = existsSync('count') ? Number(readFileSync('count', 'utf8')) + 1 : 1;\n"
  + "writeFileSync('count', String(n));\n"
  + "if (n % 2 === 0) { console.error('Error: connect ECONNREFUSED 127.0.0.1:' + (5000 + n)); process.exit(1); }\n";

test('identical failures that differ only in numbers, paths and times share a signature', () => {
  const a = normalizeFailure('AssertionError: expected 3 to equal 4\n  at /tmp/oasis-x1/a.js:10:5\nport 51234 in use after 12ms at 2026-01-02T03:04:05Z');
  const b = normalizeFailure('AssertionError: expected 7 to equal 9\n  at /tmp/oasis-y2/a.js:99:1\nport 50001 in use after 340ms at 2026-11-12T13:14:15Z');
  assert.equal(a, b);
  assert.notEqual(normalizeFailure('TypeError: x is undefined'), normalizeFailure('RangeError: bad length'));
});

test('classification covers passes, reproducible failures, varied failures and flakes', () => {
  const pass = (index) => ({ index, passed: true, exitCode: 0, seconds: 1, output: '' });
  const fail = (index, output, seconds = 1) => ({ index, passed: false, exitCode: 1, seconds, output });
  assert.equal(classifyRuns([pass(1), pass(2)]).verdict, 'passes');
  assert.equal(classifyRuns([fail(1, 'Error: boom 1'), fail(2, 'Error: boom 2')]).verdict, 'fails');
  assert.equal(classifyRuns([fail(1, 'TypeError: a'), fail(2, 'RangeError: b')]).verdict, 'fails-varied');
  const flaky = classifyRuns([pass(1), fail(2, 'Error: test timed out after 2000ms', 9), pass(3)]);
  assert.equal(flaky.verdict, 'flaky');
  assert.ok(flaky.causes.some((item) => item.cause === 'timing'));
  assert.match(flaky.hints.join('\n'), /failing runs took 9\.0s/);
});

test('a check that fails on every second run is reported as flaky with its cause', async (t) => {
  const root = workspace(t, ALTERNATING);
  const result = await runFlakyCheck(root, { command, runs: 6, stop_when_flaky: false }, { autoApprove: true, env });
  assert.equal(result.verdict, 'flaky', JSON.stringify(result, null, 1));
  assert.equal(result.runs, 6);
  assert.equal(result.passed, 3);
  assert.equal(result.failed, 3);
  assert.equal(result.failure_rate, 0.5);
  assert.equal(result.failures.length, 1, 'the port number is masked, so all three failures are one cause');
  assert.ok(result.causes.some((item) => item.cause === 'network'));
  assert.match(result.advice, /do not change product code/);
});

test('stop_when_flaky ends the run as soon as both outcomes were seen', async (t) => {
  const root = workspace(t, ALTERNATING);
  const result = await runFlakyCheck(root, { command, runs: 10 }, { autoApprove: true, env });
  assert.equal(result.verdict, 'flaky');
  assert.equal(result.runs, 2);
  assert.match(result.notes.join('\n'), /Stopped after 2 of 10/);
});

test('a real failure is reported as reproducible', async (t) => {
  const root = workspace(t, "console.error('AssertionError: expected ' + Date.now() + ' to be 0'); process.exit(1);\n");
  const result = await runFlakyCheck(root, { command, runs: 3 }, { autoApprove: true, env });
  assert.equal(result.verdict, 'fails');
  assert.equal(result.failed, 3);
  assert.match(result.advice, /Reproducible/);
  assert.match(result.confidence, /Only 3 runs/);
});

test('a passing check is reported as passing', async (t) => {
  const root = workspace(t, 'process.exit(0);\n');
  const result = await runFlakyCheck(root, { command, runs: 5 }, { autoApprove: true, env });
  assert.equal(result.verdict, 'passes');
  assert.match(result.confidence, /Consistent over 5 runs/);
});

test('concurrent copies expose a test that shares a file with itself', async (t) => {
  // Takes an exclusive lock file for a moment: alone it always passes, two
  // copies at once collide.
  const script = "import { openSync, closeSync, rmSync } from 'node:fs';\n"
    + "let fd; try { fd = openSync('lock', 'wx'); } catch (error) { console.error(error.message); process.exit(1); }\n"
    + "await new Promise((resolve) => setTimeout(resolve, 400));\n"
    + "closeSync(fd); rmSync('lock');\n";
  const root = workspace(t, script);
  const alone = await runFlakyCheck(root, { command, runs: 3 }, { autoApprove: true, env });
  assert.equal(alone.verdict, 'passes');
  const together = await runFlakyCheck(root, { command, runs: 4, concurrency: 2, stop_when_flaky: false }, { autoApprove: true, env });
  assert.ok(together.failed >= 1, JSON.stringify(together, null, 1));
  assert.ok(together.causes.some((item) => item.cause === 'files'));
});

test('one approval names the run count; a no runs nothing', async (t) => {
  const root = workspace(t, ALTERNATING);
  const prompts = [];
  const denied = await runFlakyCheck(root, { command, runs: 4 }, { approval: async (text) => { prompts.push(text); return false; }, env });
  assert.equal(denied.approved, false);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /up to 4 times/);
  const held = [];
  await runFlakyCheck(root, { command, runs: 2 }, { autoApprove: true, injectionHold: 'a fetched page asked for it', approval: async (text, high) => { held.push(high); return false; }, env });
  assert.deepEqual(held, [true], 'an injection hold asks a person even in auto mode');
});

test('a command with pipes is refused', async (t) => {
  const root = workspace(t, '');
  await assert.rejects(runFlakyCheck(root, { command: 'npm test | tee log' }, { autoApprove: true, env }), /simple command line/);
});

test('flaky_check is a registered tool that runs through executeTool', async (t) => {
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.function.name === 'flaky_check'));
  const root = workspace(t, ALTERNATING);
  const result = await executeTool('flaky_check', { command, runs: 4 }, { root, autoApprove: true, env });
  assert.equal(result.verdict, 'flaky');
});
