import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ochiai, rankLines, runLocalizeFault, v8LinesExecuted } from '../src/fault-localize.mjs';
import { executeTool, TOOL_DEFINITIONS } from '../src/tools.mjs';

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_TEST_CONTEXT' && key !== 'NODE_V8_COVERAGE'));

// A shipping-cost module with a wrong-result bug in one branch: nothing
// throws there, so a stack trace would not point at it.
const SOURCE = [
  'export function shipping(weight, country) {',
  '  if (weight <= 0) throw new RangeError("weight must be positive");',
  '  let cost = 5;',
  '  if (country === "US") {',
  '    cost += weight * 2;',
  '  } else if (country === "CA") {',
  '    cost += weight * 3 - 10;', // the bug: should be weight * 3
  '  } else {',
  '    cost += weight * 4;',
  '  }',
  '  return cost;',
  '}',
  ''
].join('\n');

function project(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'oasis-sbfl-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'test'));
  writeFileSync(path.join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(path.join(root, 'src', 'shipping.mjs'), SOURCE);
  const spec = (name, body) => writeFileSync(path.join(root, 'test', name), "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { shipping } from '../src/shipping.mjs';\n" + body);
  spec('us.test.mjs', "test('us', () => { assert.equal(shipping(2, 'US'), 9); });\n");
  spec('eu.test.mjs', "test('eu', () => { assert.equal(shipping(2, 'DE'), 13); });\n");
  spec('zero.test.mjs', "test('zero', () => { assert.throws(() => shipping(0, 'US'), RangeError); });\n");
  spec('ca.test.mjs', "test('ca', () => { assert.equal(shipping(2, 'CA'), 11); });\n");
  return root;
}

test('the Ochiai score is 1 for a line only failing tests run, lower when passing tests run it too', () => {
  assert.equal(ochiai(2, 0, 2), 1);
  assert.ok(ochiai(2, 3, 2) < ochiai(2, 1, 2));
  assert.equal(ochiai(0, 5, 2), 0);
});

test('V8 block coverage maps to executed lines, with inner blocks overriding outer ones', () => {
  const source = 'function f(x) {\n  if (x) {\n    return 1;\n  }\n  return 2;\n}\nf(false);\n';
  const thenStart = source.indexOf('{\n    return 1');
  const thenEnd = source.indexOf('}\n  return 2') + 1;
  const functions = [
    { ranges: [{ startOffset: 0, endOffset: source.length, count: 1 }] },
    { ranges: [{ startOffset: 0, endOffset: source.indexOf('\nf(false)'), count: 1 }, { startOffset: thenStart, endOffset: thenEnd, count: 0 }] }
  ];
  const lines = v8LinesExecuted(source, functions);
  assert.ok(lines.has(1) && lines.has(5) && lines.has(7));
  assert.equal(lines.has(3), false, 'the untaken branch did not run');
});

test('ranking merges neighbouring lines and gives ties the same rank', () => {
  const cov = (pairs) => new Map(Object.entries(pairs).map(([file, list]) => [file, new Set(list)]));
  const ranked = rankLines([
    { passed: false, coverage: cov({ 'a.js': [1, 2, 3, 7, 8] }) },
    { passed: true, coverage: cov({ 'a.js': [1, 2, 3] }) }
  ]);
  assert.equal(ranked.ranges[0].file, 'a.js');
  assert.deepEqual([ranked.ranges[0].start, ranked.ranges[0].end, ranked.ranges[0].score, ranked.ranges[0].rank], [7, 8, 1, 1]);
  assert.equal(ranked.ranges[1].rank, 2);
});

test('the faulty branch ranks first on a wrong-result bug with no stack trace', async (t) => {
  const root = project(t);
  const result = await runLocalizeFault(root, { command: process.execPath + ' --test', tests: ['test/us.test.mjs', 'test/eu.test.mjs', 'test/zero.test.mjs', 'test/ca.test.mjs'] }, { autoApprove: true, env });
  assert.equal(result.ok, true, JSON.stringify(result, null, 1));
  assert.equal(result.failing, 1);
  assert.equal(result.passing, 3);
  const first = result.locations[0];
  assert.equal(first.rank, 1);
  assert.match(first.location, /^src\/shipping\.mjs:6(-7)?$|^src\/shipping\.mjs:7$/, JSON.stringify(result.locations, null, 1));
  assert.match(first.code, /weight \* 3 - 10/);
  assert.equal(first.score, 1);
  assert.ok(result.locations.every((item) => !item.location.startsWith('test/')), 'test files are never ranked');
  assert.ok(result.tests.find((item) => item.test === 'test/ca.test.mjs').result === 'fail');
});

test('all-passing tests, too few tests and shell syntax are reported or refused', async (t) => {
  const root = project(t);
  const passing = await runLocalizeFault(root, { command: process.execPath + ' --test', tests: ['test/us.test.mjs', 'test/eu.test.mjs'] }, { autoApprove: true, env });
  assert.equal(passing.ok, false);
  assert.match(passing.message, /Every test passed/);
  await assert.rejects(runLocalizeFault(root, { command: 'node --test', tests: ['test/us.test.mjs'] }, { autoApprove: true, env }), /at least two tests/);
  await assert.rejects(runLocalizeFault(root, { command: 'node --test', tests: ['a.mjs', 'b.mjs; rm -rf /'] }, { autoApprove: true, env }), /not an option or shell syntax/);
});

test('one approval names the test count; a no runs nothing', async (t) => {
  const root = project(t);
  const prompts = [];
  const result = await runLocalizeFault(root, { command: 'node --test', tests: ['test/us.test.mjs', 'test/ca.test.mjs'] }, { approval: async (text) => { prompts.push(text); return false; }, env });
  assert.equal(result.approved, false);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Run 2 tests one at a time/);
});

test('localize_fault is a registered tool that runs through executeTool', async (t) => {
  assert.ok(TOOL_DEFINITIONS.some((tool) => tool.function.name === 'localize_fault'));
  const root = project(t);
  const result = await executeTool('localize_fault', { command: process.execPath + ' --test', tests: ['test/us.test.mjs', 'test/ca.test.mjs'], top: 3 }, { root, autoApprove: true, env });
  assert.equal(result.ok, true);
  assert.ok(result.locations.length <= 3);
});
