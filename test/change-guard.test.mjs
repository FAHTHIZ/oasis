import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { findElisionPlaceholder, assertNoNewElision, shrinkWarning, recordAndDetectCircling } from '../src/change-guard.mjs';
import { executeTool } from '../src/tools.mjs';

test('detects common elision placeholders', () => {
  for (const sample of [
    '// ... rest of the code unchanged',
    '  # ... existing code ...',
    '/* rest of file remains the same */',
    '<!-- ... remaining code here -->',
    '// existing code unchanged',
    '// ... code omitted'
  ]) assert.ok(findElisionPlaceholder('a\n' + sample + '\nb'), sample);
});

test('does not flag ordinary code or prose', () => {
  for (const sample of [
    'const rest = args.slice(1); // rest of the arguments',
    'for (const item of list) { /* existing behaviour */ }',
    'console.log("...")',
    '// Keep the existing validation order: deny > ask > allow.',
    'return [...rest, ...existing];'
  ]) assert.equal(findElisionPlaceholder(sample), '', sample);
});

test('placeholder already present in previous text is allowed', () => {
  assert.doesNotThrow(() => assertNoNewElision('x\n// ... rest of the code unchanged\n', 'y\n// ... rest of the code unchanged\n', 'a.js'));
  assert.throws(() => assertNoNewElision('x\n', 'y\n// ... rest of the code unchanged\n', 'a.js'), /placeholder/);
});

test('shrink warning only fires for large removals of sizable files', () => {
  const big = Array.from({ length: 100 }, (_, i) => 'line ' + i).join('\n');
  assert.equal(shrinkWarning('a\nb', '', 'small.txt'), '');
  assert.equal(shrinkWarning(big, big.split('\n').slice(0, 80).join('\n'), 'big.txt'), '');
  assert.match(shrinkWarning(big, big.split('\n').slice(0, 10).join('\n'), 'big.txt'), /shrank big\.txt from 100 to 10 lines \(90% removed\)/);
});

test('circling detection flags A -> B -> C -> A and repeated bouncing, but not one undo', () => {
  const holder = {};
  assert.equal(recordAndDetectCircling(holder, '/f', 'A', 'B', 'f'), '');
  assert.equal(recordAndDetectCircling(holder, '/f', 'B', 'C', 'f'), '');
  assert.match(recordAndDetectCircling(holder, '/f', 'C', 'A', 'f'), /2 edit\(s\) ago/);
  const undo = {};
  assert.equal(recordAndDetectCircling(undo, '/u', 'A', 'B', 'u'), '');
  assert.equal(recordAndDetectCircling(undo, '/u', 'B', 'A', 'u'), '', 'a single undo is legitimate');
  assert.equal(recordAndDetectCircling(undo, '/u', 'A', 'B', 'u'), '');
  assert.match(recordAndDetectCircling(undo, '/u', 'B', 'A', 'u'), /circling/, 'bouncing A/B repeatedly is flagged');
  const other = {};
  assert.equal(recordAndDetectCircling(other, '/g', 'A', 'B', 'g'), '');
  assert.equal(recordAndDetectCircling(other, '/g', 'B', 'C', 'g'), '');
  assert.equal(recordAndDetectCircling(other, '/g', 'C', 'D', 'g'), '');
});

test('write_file and edit_file enforce the guard end to end', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-guard-'));
  try {
    const file = path.join(root, 'app.js');
    const original = Array.from({ length: 60 }, (_, i) => 'export const v' + i + ' = ' + i + ';').join('\n') + '\n';
    await writeFile(file, original);
    const context = { root, autoApprove: true, session: {} };
    await executeTool('read_file', { path: 'app.js' }, context);

    await assert.rejects(
      executeTool('write_file', { path: 'app.js', content: 'export const v0 = 1;\n// ... rest of the code unchanged\n' }, context),
      /placeholder/
    );
    assert.equal(await readFile(file, 'utf8'), original, 'blocked write must not touch the file');

    await assert.rejects(
      executeTool('edit_file', { path: 'app.js', old_string: 'export const v1 = 1;', new_string: '// ... existing code ...' }, context),
      /placeholder/
    );

    const shrunk = await executeTool('write_file', { path: 'app.js', content: 'export const v0 = 0;\n' }, context);
    assert.match(shrunk.warning || '', /removed/);

    const restored = await executeTool('write_file', { path: 'app.js', content: original }, context);
    assert.equal(restored.warning, undefined);
    await executeTool('write_file', { path: 'app.js', content: 'export const v0 = 0;\n' }, context);
    const again = await executeTool('write_file', { path: 'app.js', content: original }, context);
    assert.match(again.warning || '', /circling/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test-weakening check flags removed assertions, skips and always-true asserts in test files', async () => {
  const { testTamperWarning, isTestPath } = await import('../src/change-guard.mjs');
  assert.ok(isTestPath('test/parser.test.mjs'));
  assert.ok(isTestPath('src/__tests__/a.js'));
  assert.ok(isTestPath('pkg/foo_test.go'));
  assert.ok(isTestPath('tests/test_api.py'));
  assert.ok(!isTestPath('src/parser.mjs'));
  const before = "test('adds', () => {\n  assert.equal(add(1, 2), 3);\n  assert.equal(add(2, 2), 4);\n});\n";
  assert.match(testTamperWarning(before, "test('adds', () => {\n  assert.equal(add(1, 2), 3);\n});\n", 'test/add.test.mjs'), /removed 1 assertion/);
  assert.match(testTamperWarning(before, before.replace("test('adds'", "test.skip('adds'"), 'test/add.test.mjs'), /added 1 skip/);
  assert.match(testTamperWarning("def test_a():\n    assert f() == 2\n", "def test_a():\n    assert True\n", 'tests/test_a.py'), /always-true/);
  assert.match(testTamperWarning("it('x', () => { expect(f()).toBe(2); });", "it('x', () => { expect(true).toBe(true); });", 'a.spec.ts'), /always-true/);
  assert.equal(testTamperWarning(before, before + "test('subs', () => { assert.equal(sub(3, 1), 2); });\n", 'test/add.test.mjs'), '', 'adding tests is fine');
  assert.equal(testTamperWarning(before, "x", 'src/add.mjs'), '', 'non-test files are ignored');
  assert.equal(testTamperWarning(null, before, 'test/add.test.mjs'), '', 'new files are ignored');
});

test('edit_file reports test weakening back to the model', async () => {
  const { mkdtemp, writeFile, mkdir, rm } = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const { executeTool } = await import('../src/tools.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-tamper-'));
  try {
    await mkdir(path.join(root, 'test'));
    await writeFile(path.join(root, 'test', 'a.test.mjs'), "test('a', () => {\n  assert.equal(f(), 2);\n});\n");
    const result = await executeTool('edit_file', { path: 'test/a.test.mjs', old_string: "test('a'", new_string: "test.skip('a'" }, { root, autoApprove: true, approval: async () => true });
    assert.match(JSON.stringify(result), /Test-weakening check/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('test-weakening check counts Python bare asserts', async () => {
  const { testTamperWarning } = await import('../src/change-guard.mjs');
  assert.match(testTamperWarning("def test_a():\n    assert f() == 2\n    assert g() == 3\n", "def test_a():\n    assert f() == 2\n", 'tests/test_a.py'), /removed 1 assertion/);
});
