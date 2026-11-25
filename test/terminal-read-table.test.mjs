import test from 'node:test';
import assert from 'node:assert/strict';
import * as ui from '../src/terminal-ui.mjs';

test('reading a CSV says how many data rows it has besides the header', () => {
  const fn = Object.values(ui).find((f) => typeof f === 'function' && /Read ' \+ lines/.test(String(f)));
  assert.ok(fn, 'result summary function');
  const content = 'a,b\n' + Array.from({ length: 300 }, (_, i) => i + ',' + i).join('\n') + '\n';
  const line = fn('read_file', { content, table: { columns: ['a', 'b'], dataRows: 300 } }).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(line, /Read 301 lines \(300 rows \+ header\)/);
  const plain = fn('read_file', { content: 'x\ny\n' }).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(plain, /Read 2 lines$/);
});
