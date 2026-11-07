import test from 'node:test';
import assert from 'node:assert/strict';
import { planToolBatches } from '../src/tool-batch-scheduler.mjs';

const call = (name, id = name) => ({ id, function: { name } });
const isNamed = (name) => (item) => item.function && item.function.name === name;

test('empty input produces no batches', () => {
  assert.deepEqual(planToolBatches([]), []);
  assert.deepEqual(planToolBatches(null), []);
});

test('consecutive read-only calls share a batch', () => {
  const calls = [call('read_file', 'a'), call('search_files', 'b'), call('git_diff', 'c')];
  const batches = planToolBatches(calls, { isReadOnly: (item) => ['read_file', 'search_files', 'git_diff'].includes(item.function.name) });
  assert.equal(batches.length, 1);
  assert.equal(batches[0].kind, 'read-only');
  assert.deepEqual(batches[0].calls, calls);
  assert.equal(batches[0].concurrency, 3);
});

test('mutations remain ordering barriers between read batches', () => {
  const calls = [call('read_file', 'before'), call('edit_file', 'write'), call('read_file', 'after')];
  const batches = planToolBatches(calls, { isReadOnly: isNamed('read_file') });
  assert.deepEqual(batches.map((batch) => batch.kind), ['read-only', 'single', 'read-only']);
  assert.deepEqual(batches.map((batch) => batch.calls.map((item) => item.id)), [['before'], ['write'], ['after']]);
});

test('only adjacent specialist reviews are grouped', () => {
  const calls = [call('run_specialist_review', 'r1'), call('run_specialist_review', 'r2'), call('edit_file', 'edit'), call('run_specialist_review', 'r3')];
  const batches = planToolBatches(calls, { isSpecialistReview: isNamed('run_specialist_review') });
  assert.deepEqual(batches.map((batch) => batch.kind), ['specialist-review', 'single', 'specialist-review']);
  assert.deepEqual(batches[0].calls.map((item) => item.id), ['r1', 'r2']);
  assert.equal(batches[0].concurrency, 2);
});

test('subagent batches use the configured parallel cap', () => {
  const calls = [call('task', 'a'), call('task', 'b'), call('task', 'c'), call('read_file', 'r')];
  const batches = planToolBatches(calls, { isTask: isNamed('task'), isReadOnly: isNamed('read_file'), maxParallelTasks: 2 });
  assert.deepEqual(batches.map((batch) => batch.kind), ['subagent', 'read-only']);
  assert.equal(batches[0].calls.length, 3);
  assert.equal(batches[0].concurrency, 2);
  assert.equal(batches[1].concurrency, 1);
});

test('non-parallel calls stay isolated and original call order is preserved', () => {
  const calls = [call('edit_file', 'e1'), call('run_command', 'cmd'), call('edit_file', 'e2')];
  const batches = planToolBatches(calls);
  assert.deepEqual(batches.map((batch) => batch.calls.map((item) => item.id)), [['e1'], ['cmd'], ['e2']]);
  assert.deepEqual(batches.flatMap((batch) => batch.calls), calls);
});

test('read-only classification takes precedence over other predicates', () => {
  const item = call('special', 'x');
  const batches = planToolBatches([item], {
    isReadOnly: () => true,
    isSpecialistReview: () => true,
    isTask: () => true
  });
  assert.equal(batches[0].kind, 'read-only');
});
