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

test('search_files honours a path scope and trims long minified lines', async () => {
  const { searchWorkspaceFiles } = await import('../src/tools.mjs');
  const { mkdir } = await import('node:fs/promises');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-search-'));
  await mkdir(path.join(root, 'src'));
  await writeFile(path.join(root, 'index.html'), 'x'.repeat(500) + ' clamp(1px) ' + 'y'.repeat(500));
  await writeFile(path.join(root, 'src', 'a.mjs'), 'export function clampInteger() {}\n');
  const scoped = await searchWorkspaceFiles(root, 'clamp', 25, 'src');
  assert.deepEqual(scoped.matches.map((m) => m.path), ['src/a.mjs']);
  const all = await searchWorkspaceFiles(root, 'clamp');
  const html = all.matches.find((m) => m.path === 'index.html');
  assert.ok(html.text.length <= 202 && html.text.includes('clamp('), html.text);
  await assert.rejects(() => searchWorkspaceFiles(root, 'clamp', 25, '../'), /outside the workspace/);
});

test('edit_file accepts old_str/new_str and small unified diffs; explains the shape otherwise', async () => {
  const { editFileArgs } = await import('../src/tools.mjs');
  assert.deepEqual(editFileArgs({ path: 'a', old_str: 'x', new_str: 'y' }).old_string, 'x');
  const fromDiff = editFileArgs({ path: 'a', line_start: 1, changes: '-const a = 1;\n+const a = 2;\n keep();' });
  assert.equal(fromDiff.old_string, 'const a = 1;\nkeep();');
  assert.equal(fromDiff.new_string, 'const a = 2;\nkeep();');
  assert.throws(() => editFileArgs({ path: 'a', line_start: 1, line_end: 3 }), /needs old_string .*got path, line_start, line_end/);
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-edit-'));
  await writeFile(path.join(root, 'a.mjs'), 'const a = 1;\nkeep();\n');
  await executeTool('edit_file', { path: 'a.mjs', changes: '-const a = 1;\n+const a = 2;' }, { root, autoApprove: true });
  const { readFile } = await import('node:fs/promises');
  assert.equal(await readFile(path.join(root, 'a.mjs'), 'utf8'), 'const a = 2;\nkeep();\n');
});

test('search/grep aliases and harmony-suffixed names resolve', () => {
  const names = ['grep', 'search_files', 'read_file'];
  const s = resolveToolAlias('search', { path: 'src', pattern: 'notes' }, names);
  assert.equal(s.name, 'grep');
  assert.equal(s.args.pattern, 'notes');
  assert.equal(resolveToolAlias('grepl_commentary', { query: 'x' }, names).name, 'grep');
  assert.equal(resolveToolAlias('read_file_analysis', {}, names).name, 'read_file');
});

test('grep accepts regex/query as the pattern', async () => {
  const { grepWorkspace } = await import('../src/power-tools.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-grep-'));
  await writeFile(path.join(root, 'a.txt'), 'hello list\n');
  const result = await grepWorkspace(root, { regex: 'list' });
  assert.ok(JSON.stringify(result).includes('a.txt'), JSON.stringify(result));
});
