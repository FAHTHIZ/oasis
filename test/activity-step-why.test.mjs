import test from 'node:test';
import assert from 'node:assert/strict';
import { stepWhy } from '../app/activity.mjs';

test('a failed step in the Activity panel says why, from JSON or text results', () => {
  assert.equal(stepWhy({ content: '{"error":"Edit 1: old_string and new_string are identical."}' }), 'Edit 1: old_string and new_string are identical.');
  assert.equal(stepWhy({ content: '{"error":"ENOENT: no such file"}\n[note] read it first' }), 'ENOENT: no such file');
  assert.equal(stepWhy({ content: '{"exitCode":1,"stderr":"npm ERR! missing script"}' }), 'npm ERR! missing script');
  assert.equal(stepWhy({ content: '\n  plain failure\nsecond line' }), 'plain failure');
  assert.equal(stepWhy({}), '');
  assert.ok(stepWhy({ content: 'x'.repeat(500) }).length <= 300);
});

test('an Error box that only repeats the why line is recognised', async () => {
  const { repeatsWhy } = await import('../app/activity.mjs');
  assert.equal(repeatsWhy('This step failed: Bad args.', 'Bad args.'), true);
  assert.equal(repeatsWhy('Bad args.', 'Bad args.'), true);
  assert.equal(repeatsWhy('Bad args.\nstack trace line', 'Bad args.'), false);
  assert.equal(repeatsWhy('anything', ''), false);
});

test('an MCP tool error shows the server message, not its JSON envelope', async () => {
  const { stepResult, readableOutput } = await import('../app/core/timeline.mjs');
  const content = JSON.stringify({ isError: true, content: 'MCP tool reported an error:\nError fetching wiki for a/b: Repository not found. Visit https://deepwiki.com/a/b to index it.' });
  const why = 'Error fetching wiki for a/b: Repository not found. Visit https://deepwiki.com/a/b to index it.';
  assert.equal(stepWhy({ content }), why);
  assert.deepEqual(stepResult({ ok: true, name: 'mcp_deepwiki_read_wiki_contents', content }), { text: why, tone: 'fail' });
  assert.equal(readableOutput(content), why);
  // Array content, as some servers return it.
  assert.equal(stepWhy({ content: JSON.stringify({ isError: true, content: [{ type: 'text', text: 'quota exceeded' }] }) }), 'quota exceeded');
  // A successful MCP result is left alone.
  assert.equal(stepWhy({ content: JSON.stringify({ isError: false, content: 'fine' }) }), '');
});

test('a read that ends with a newline counts its lines without a phantom one', async () => {
  const { stepResult } = await import('../app/core/timeline.mjs');
  const content = JSON.stringify({ path: 'notes.txt', content: 'line one\nhello world\n', startLine: 1, endLine: 2, totalLines: 2, truncated: false });
  assert.equal(stepResult({ ok: true, name: 'read_file', content }).text, 'Read 2 lines');
});
