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

test('a line count reported as data rows, header and all, is flagged', () => {
  const wc = [{ kind: 'command', tool: 'run_command', command: 'wc -l sales.csv', numbers: ['301'] }];
  const [issue] = analysisContract('The sales.csv file contains 301 data rows (the first line is the header).', wc);
  assert.match(issue.reason, /301 lines including its header row, so 300 data rows/);
  const read = [{ kind: 'read', tool: 'read_file', path: 'sales.csv', table: { dataRows: 300, header: true } }, ...wc];
  assert.match(analysisContract('There are 301 rows excluding the header.', read)[0].reason, /sales\.csv has 301 lines/);
  // Said correctly, nothing to flag.
  assert.deepEqual(analysisContract('301 lines including the header, so 300 data rows.', read), []);
  assert.deepEqual(analysisContract('The file has 301 rows including the header.', wc), []);
  // A header-less file whose rows really are 301.
  assert.deepEqual(analysisContract('301 data rows.', [{ kind: 'read', tool: 'read_file', path: 'n.csv', table: { dataRows: 301, header: false } }, ...wc]), []);
});
