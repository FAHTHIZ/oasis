import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, summarize } from '../scripts/bench-perf.mjs';

test('bench:perf options are bounded and unknown flags are refused', () => {
  assert.deepEqual(parseArgs([]), { runs: 7, json: '' });
  assert.equal(parseArgs(['--runs', '3']).runs, 3);
  assert.throws(() => parseArgs(['--runs', '0']), /1-50/);
  assert.throws(() => parseArgs(['--fast']), /Unknown/);
});

test('bench:perf summaries use nearest-rank percentiles and skip missing samples', () => {
  assert.deepEqual(summarize([30, 10, 20, NaN]), { runs: 3, median: 20, p90: 30, min: 10, max: 30 });
  assert.equal(summarize([]), null);
});
