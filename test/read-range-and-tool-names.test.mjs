import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readRangeArgs, executeTool } from '../src/tools.mjs';
import { resolveToolAlias } from '../src/tool-aliases.mjs';

test('read_file maps line_start/line_end style ranges onto offset/limit', () => {
  assert.deepEqual(readRangeArgs({ line_start: 50, line_end: 120 }), { offset: 50, limit: 71 });
  assert.deepEqual(readRangeArgs({ start_line: '5', end_line: '6' }), { offset: 5, limit: 2 });
  assert.deepEqual(readRangeArgs({ offset: 3, limit: 2, line_start: 99 }), { offset: 3, limit: 2 }, 'explicit offset/limit win');
  assert.deepEqual(readRangeArgs({}), { offset: undefined, limit: undefined });
});

test('read_file with line_start/line_end returns only that range', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-range-'));
  await writeFile(path.join(root, 'a.txt'), Array.from({ length: 50 }, (_, i) => 'line ' + (i + 1)).join('\n'));
  const result = await executeTool('read_file', { path: 'a.txt', line_start: 10, line_end: 12 }, { root });
  assert.equal(result.startLine, 10);
  assert.equal(result.endLine, 12);
  assert.match(result.content, /line 10/);
  assert.doesNotMatch(result.content, /line 13\b/);
});

test('unknown tool names that contain a real tool name get a suggestion', () => {
  const names = ['read_file', 'write_file', 'git_status', 'grep'];
  assert.match(resolveToolAlias('readlines_file', {}, names).error, /Did you mean: read_file/);
  assert.match(resolveToolAlias('file_read', {}, names).error, /read_file/);
});

test('common read-only aliases map to read_file', () => {
  for (const name of ['view', 'open_file', 'cat', 'read_lines']) {
    const resolved = resolveToolAlias(name, { file_path: 'x.txt' }, ['read_file']);
    assert.equal(resolved.name, 'read_file', name);
    assert.equal(resolved.args.path, 'x.txt');
  }
});
