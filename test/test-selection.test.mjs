import test from 'node:test';
import assert from 'node:assert/strict';
import { selectTests } from '../src/test-selection.mjs';

const tests = ['src/foo.test.js', 'src/bar.spec.ts', 'src/__tests__/baz.js', 'test/qux_test.py'];

const fileContents = new Map([
  ['src/foo.js', 'import { helper } from "./helper.js";'],
  ['src/helper.js', 'export function helper() {}'],
  ['src/foo.test.js', 'import { helper } from "./helper.js";'],
  ['src/bar.js', 'export const x = 1;'],
  ['src/bar.spec.ts', 'import { x } from "./bar.js";'],
  ['src/baz.js', 'export const y = 2;'],
  ['src/__tests__/baz.js', 'import { y } from "../baz.js";'],
  ['src/qux.py', 'def main(): pass'],
  ['test/qux_test.py', 'from src.qux import main']
]);

test('naming conventions select direct test files', () => {
  const result = selectTests(['src/foo.js'], tests);
  assert.ok(result.selected.includes('src/foo.test.js'));
  assert.equal(result.strategy, 'conventions');
});

test('import-graph closure selects transitive tests', () => {
  const result = selectTests(['src/helper.js'], tests, { fileContents });
  assert.ok(result.selected.includes('src/foo.test.js'));
  assert.equal(result.strategy, 'import-graph');
});

test('fallback to all tests when nothing matches', () => {
  const result = selectTests(['src/unknown.js'], tests);
  assert.equal(result.selected.length, tests.length);
  assert.equal(result.strategy, 'all');
});

test('python and go conventions work', () => {
  const result = selectTests(['src/qux.py'], tests);
  assert.ok(result.selected.includes('test/qux_test.py'));
});
