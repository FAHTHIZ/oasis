import test from 'node:test';
import assert from 'node:assert/strict';
import { analysisContract } from '../src/verification-contracts.mjs';

// Seen live: "301 lines including the header, so 300 data rows" after
// `wc -l sales.csv` ended with "Not verified (300)" and an extra round.
test('a row count that is a produced line count less the header row is supported', () => {
  const events = [{ kind: 'execution', tool: 'run_command', numbers: ['301'] }];
  assert.deepEqual(analysisContract('The file has 301 lines including the header, so there are 300 data rows.', events), []);
  // Without the header said in words, or off by more than one row, it is not.
  assert.equal(analysisContract('There are 300 data rows.', events).length, 1);
  assert.equal(analysisContract('Excluding the header there are 299 rows.', events).length, 1);
});
