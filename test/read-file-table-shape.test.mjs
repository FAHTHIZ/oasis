import test from 'node:test';
import assert from 'node:assert/strict';
import { tableShape } from '../src/tools.mjs';

test('a CSV read comes with its columns and exact data-row count', () => {
  const csv = 'date,region,product,units\n' + Array.from({ length: 300 }, (_, i) => '2026-01-01,North,Widget,' + i).join('\n') + '\n';
  assert.deepEqual(tableShape('sales.csv', csv), { columns: ['date', 'region', 'product', 'units'], dataRows: 300, note: 'dataRows excludes the header row.' });
  // Quoted fields with commas and newlines are one cell; blank lines do not count.
  const quoted = 'name,notes\n"Smith, J","line one\nline two"\n\nDoe,ok\r\n';
  assert.equal(tableShape('people.csv', quoted).dataRows, 2);
  // No header: every row counts.
  assert.equal(tableShape('nums.csv', '1,2\n3,4\n').dataRows, 2);
  assert.equal(tableShape('t.tsv', 'a\tb\nx\t1\n').dataRows, 1);
  assert.equal(tableShape('notes.txt', 'a,b\n1,2'), null);
  assert.equal(tableShape('empty.csv', '\n\n'), null);
});
