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

test('wc -l over a CSV with a header says how many lines are data', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const os = await import('node:os');
  const pathMod = await import('node:path');
  const { lineCountTableNote } = await import('../src/tools.mjs');
  const dir = await mkdtemp(pathMod.join(os.tmpdir(), 'wc-csv-'));
  await writeFile(pathMod.join(dir, 'sales.csv'), 'date,amount\n' + Array.from({ length: 300 }, (_, i) => '2024-01-01,' + i).join('\n') + '\n');
  await writeFile(pathMod.join(dir, 'plain.csv'), '1,2\n3,4\n');
  assert.match(await lineCountTableNote(dir, 'wc', ['-l', 'sales.csv']), /sales\.csv has a header row \(date, amount\), so its data rows are 300/);
  assert.match(await lineCountTableNote(dir, 'bash', ['-c', 'wc -l sales.csv']), /data rows are 300/);
  assert.equal(await lineCountTableNote(dir, 'wc', ['-l', 'plain.csv']), '');
  assert.equal(await lineCountTableNote(dir, 'cat', ['sales.csv']), '');
  assert.equal(await lineCountTableNote(dir, 'wc', ['-l', '../../etc/x.csv']), '');
});
