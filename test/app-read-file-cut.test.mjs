import test from 'node:test';
import assert from 'node:assert/strict';
import { executeTool } from '../app/core/tools.mjs';
import { MemoryStore, Workspace } from '../app/core/workspace.mjs';

async function ws(content) {
  return Workspace.create(new MemoryStore(), { name: 'w', files: [{ path: 'big.js', content }] });
}

test('app read_file cuts at a whole line and says which offset is next', async () => {
  const content = Array.from({ length: 1500 }, (_, i) => '// line ' + (i + 1) + ' ' + 'x'.repeat(80)).join('\n');
  const workspace = await ws(content);
  const out = await executeTool('read_file', { path: 'big.js', limit: 1500 }, { workspace });
  assert.ok(out.length <= 24000, String(out.length));
  const shown = out.split('\n').filter((line) => /^\s+\d+ {2}/.test(line));
  const last = Number(shown.at(-1).trim().split(/\s+/)[0]);
  assert.match(shown.at(-1), new RegExp('// line ' + last + ' x{80}$'));
  assert.match(out, new RegExp('read again with offset ' + (last + 1) + '\\.$'));
  const again = await executeTool('read_file', { path: 'big.js', offset: last + 1, limit: 5 }, { workspace });
  assert.match(again.split('\n')[0], new RegExp('^\\s+' + (last + 1) + '  // line ' + (last + 1) + ' '));
});

test('app read_file reports an offset past the end', async () => {
  const workspace = await ws('a\nb');
  assert.match(await executeTool('read_file', { path: 'big.js', offset: 9 }, { workspace }), /has 2 lines; offset 9 is past the end/);
});

test('app read_file shows a huge single line cut with its length', async () => {
  const workspace = await ws('y'.repeat(50000) + '\nnext');
  const out = await executeTool('read_file', { path: 'big.js' }, { workspace });
  assert.match(out, /line cut; it is 50000 characters long\)\n\s+2  next$/);
});

test('app run_javascript keeps the error at the end of long output', async () => {
  const workspace = await ws('');
  const sandbox = { run: async () => ({ logs: Array.from({ length: 3000 }, (_, i) => 'log ' + i), error: 'AssertionError: expected 3 to equal 4' }) };
  const out = await executeTool('run_javascript', { code: 'x' }, { workspace, sandbox });
  assert.ok(out.length < 24200);
  assert.match(out, /^log 0\n/);
  assert.match(out, /characters of output cut[\s\S]*Error: AssertionError: expected 3 to equal 4$/);
});
