import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { changedLinesFromDiff, codeMask, lineMutations, restorePendingMutations, runMutationProbe, selectMutants } from '../src/mutation-probe.mjs';
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.mjs';

function repo(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oasis-mutation-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const run = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  run('init', '-q');
  run('config', 'user.email', 't@example.invalid');
  run('config', 'user.name', 'T');
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(root, 'price.mjs'), 'export function price(qty) {\n  return qty * 10;\n}\n');
  writeFileSync(path.join(root, 'price.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { price } from './price.mjs';\ntest('price', () => { assert.equal(price(1), 10); });\n");
  run('add', '.');
  run('commit', '-qm', 'base');
  // The change under test: bulk discount from 100 units.
  writeFileSync(path.join(root, 'price.mjs'), 'export function price(qty) {\n  if (qty >= 100) return qty * 9;\n  return qty * 10;\n}\n');
  return root;
}

const command = process.execPath + ' --test price.test.mjs';
// The outer node --test marks its children; a nested runner would then report
// to the parent and exit 0 whatever happened.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT'));

test('mutant generation stays out of strings and comments and keeps operators apart', () => {
  const mask = codeMask("if (a === 'x == y') // b && c", 'a.js');
  assert.equal(mask[6], true);
  assert.equal(mask[12], false);
  const labels = lineMutations("  if (a === 'x == y' && b < 3) { // or c >= 4", 'a.js').map((item) => item.operator);
  assert.ok(labels.includes('=== to !=='));
  assert.ok(labels.includes('&& to ||'));
  assert.ok(labels.includes('< to <='));
  assert.ok(labels.includes('negated if condition'));
  assert.ok(labels.includes('constant 3 to 4'));
  assert.ok(!labels.includes('== to !='), 'the == inside the string is not code');
  assert.ok(!labels.includes('>= to >'), 'the >= inside the comment is not code');
  const py = lineMutations('    if value is None and ready:', 'x.py').map((item) => item.operator);
  assert.ok(py.includes('is None to is not None'));
  assert.ok(py.includes('and to or'));
  assert.ok(py.includes('negated if condition'));
  assert.deepEqual(lineMutations("import { a } from './b.js';", 'a.js'), []);
});

test('changed lines come from the new side of a zero-context diff', () => {
  const lines = changedLinesFromDiff('diff --git a/x.js b/x.js\n--- a/x.js\n+++ b/x.js\n@@ -2,0 +3,2 @@\n+a\n+b\n@@ -9 +11 @@\n-c\n+d\n');
  assert.deepEqual([...lines.get('x.js')].sort((a, b) => a - b), [3, 4, 11]);
});

test('selection spreads the budget across lines before doubling up', () => {
  const candidates = [1, 1, 1, 2, 2, 3].map((line, index) => ({ file: 'a.js', line, mutated: String(index) }));
  const picked = selectMutants(candidates, 3);
  assert.deepEqual(picked.map((item) => item.line), [1, 2, 3]);
});

test('weak tests: the revert check and surviving mutants expose the gap, and files are restored exactly', async (t) => {
  const root = repo(t);
  const file = path.join(root, 'price.mjs');
  const before = readFileSync(file);
  const mtime = statSync(file).mtimeMs;
  const result = await runMutationProbe(root, { command, max_mutants: 6 }, { autoApprove: true, env });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.counterfactual.tests_fail_without_change, false, 'the old code passes the old test');
  assert.ok(result.mutants.survived >= 1, JSON.stringify(result.mutants));
  assert.ok(result.survivors.every((item) => item.file === 'price.mjs' && item.line === 2), 'only the changed line is mutated');
  assert.match(result.advice, /pass on the old code/);
  assert.ok(readFileSync(file).equals(before), 'source restored byte for byte');
  assert.ok(Math.abs(statSync(file).mtimeMs - mtime) < 1, 'modification time restored');
  assert.equal(existsSync(path.join(root, '.oasis', 'mutation-probe', 'journal.json')), false);
});

test('strong tests: every meaningful mutant is killed and the revert check fails', async (t) => {
  const root = repo(t);
  writeFileSync(path.join(root, 'price.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { price } from './price.mjs';\ntest('price', () => { assert.equal(price(1), 10); assert.equal(price(99), 990); assert.equal(price(100), 900); assert.equal(price(101), 909); });\n");
  const result = await runMutationProbe(root, { command, max_mutants: 10 }, { autoApprove: true, env });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.counterfactual.tests_fail_without_change, true);
  assert.equal(result.mutants.survived, 0, JSON.stringify(result.survivors));
  assert.equal(result.mutants.score_percent, 100);
});

test('a failing baseline stops before any file is touched', async (t) => {
  const root = repo(t);
  writeFileSync(path.join(root, 'price.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert';\ntest('x', () => { assert.equal(1, 2); });\n");
  const before = readFileSync(path.join(root, 'price.mjs'), 'utf8');
  const result = await runMutationProbe(root, { command }, { autoApprove: true, env });
  assert.equal(result.ok, false);
  assert.match(result.message, /does not pass/);
  assert.equal(readFileSync(path.join(root, 'price.mjs'), 'utf8'), before);
});

test('one approval names the command and the run count; a no changes nothing', async (t) => {
  const root = repo(t);
  const prompts = [];
  const result = await runMutationProbe(root, { command, max_mutants: 3 }, { env, approval: async (text) => { prompts.push(text); return false; } });
  assert.equal(result.approved, false);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /mutation probe/i);
  assert.match(prompts[0], /up to 5 times/);
  assert.match(prompts[0], /price\.mjs/);
});

test('an injection hold asks a person even in auto mode', async (t) => {
  const root = repo(t);
  const asked = [];
  const result = await runMutationProbe(root, { command, max_mutants: 1 }, { autoApprove: true, env, injectionHold: 'a fetched page tried to give instructions', approval: async (text, risky) => { asked.push(risky); return false; } });
  assert.equal(result.approved, false);
  assert.deepEqual(asked, [true]);
});

test('a journal left by a crash is restored before the next probe', async (t) => {
  const root = repo(t);
  const file = path.join(root, 'price.mjs');
  const original = readFileSync(file);
  writeFileSync(file, 'broken');
  mkdirSync(path.join(root, '.oasis', 'mutation-probe'), { recursive: true });
  writeFileSync(path.join(root, '.oasis', 'mutation-probe', 'journal.json'), JSON.stringify({ version: 1, files: [{ relative: 'price.mjs', content: original.toString('base64'), mtime: Date.now(), atime: Date.now() }, { relative: '../escape.txt', content: '' }] }));
  assert.deepEqual(await restorePendingMutations(root), ['price.mjs']);
  assert.ok(readFileSync(file).equals(original));
  assert.equal(existsSync(path.join(root, '..', 'escape.txt')), false);
});

test('a journal owned by a live process is left alone, and a second probe waits', async (t) => {
  const root = repo(t);
  const file = path.join(root, 'price.mjs');
  const current = readFileSync(file, 'utf8');
  const child = (await import('node:child_process')).spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
  t.after(() => child.kill());
  mkdirSync(path.join(root, '.oasis', 'mutation-probe'), { recursive: true });
  writeFileSync(path.join(root, '.oasis', 'mutation-probe', 'journal.json'), JSON.stringify({ version: 1, pid: child.pid, files: [{ relative: 'price.mjs', content: Buffer.from('old').toString('base64') }] }));
  assert.deepEqual(await restorePendingMutations(root), []);
  assert.equal(readFileSync(file, 'utf8'), current);
  const result = await runMutationProbe(root, { command }, { autoApprove: true, env });
  assert.equal(result.busy, true);
});

test('test files and non-source files are never mutated', async (t) => {
  const root = repo(t);
  execFileSync('git', ['checkout', '-q', '--', 'price.mjs'], { cwd: root });
  writeFileSync(path.join(root, 'price.test.mjs'), readFileSync(path.join(root, 'price.test.mjs'), 'utf8') + '// more\n');
  writeFileSync(path.join(root, 'notes.md'), 'if a < b\n');
  const result = await runMutationProbe(root, { command }, { autoApprove: true, env });
  assert.equal(result.ok, false);
  assert.ok(result.skipped.some((item) => item.path === 'price.test.mjs' && item.reason === 'test file'));
  assert.ok(result.skipped.some((item) => item.path === 'notes.md'));
});

test('mutation_probe is a registered tool that runs through executeTool', async (t) => {
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.function.name === 'mutation_probe'));
  const root = repo(t);
  const result = await executeTool('mutation_probe', { command, max_mutants: 2, revert_check: false }, { root, autoApprove: true, env });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.counterfactual, undefined);
  assert.equal(result.mutants.tested, 2);
});
