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

test('command headers quote an argument with a single quote without the hard-to-read \'\\\'\' form', async () => {
  const { execFileSync } = await import('node:child_process');
  for (const arg of ["print('$x')", "it's", 'END{print $1}', "a'\\b\"c"]) {
    const quoted = ui.shellQuote(arg);
    assert.equal(execFileSync('bash', ['-c', 'printf %s ' + quoted]).toString(), arg, quoted);
    if (!arg.includes('!')) assert.ok(!quoted.includes("'\\''"), quoted);
  }
});

test('wc -l on a CSV shows the data rows next to the line count', () => {
  const line = ui.describeToolResult('run_command', { exitCode: 0, stdout: '301 sales.csv\n', tableNote: 'sales.csv has a header row (date, amount), so its data rows are 300, not the line count.' }, { color: false });
  assert.match(line, /✓ exit 0 · 301 sales\.csv \(300 data rows \+ header\)/);
});
