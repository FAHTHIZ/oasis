import test from 'node:test';
import assert from 'node:assert/strict';
import { labelToolResult } from '../src/cli.mjs';

// Seen live: two parallel reads printed both headers, then "⎿ Read 3 lines"
// and "⎿ Read 4 lines" with nothing saying which file each was.
test('a result printed away from its header names its call', () => {
  const call = (args) => ({ id: 'x', function: { name: 'read_file', arguments: JSON.stringify(args) } });
  assert.equal(labelToolResult('  ⎿ Read 3 lines', 'read_file', call({ path: 'add.mjs' })), '  ⎿ add.mjs · Read 3 lines');
  assert.equal(labelToolResult('  ⎿ exit 0', 'run_command', call({ command: 'node test.mjs' })), '  ⎿ node test.mjs · exit 0');
  assert.match(labelToolResult('  ⎿ 2 files', 'glob', call({ pattern: 'a'.repeat(80) })), /⎿ a{39}… · 2 files/);
  assert.equal(labelToolResult('  ⎿ done', 'todo_write', call({})), '  ⎿ done');
});

test('retry notices say what happened and only mention a partial reply when one was shown', async () => {
  const { streamRestartNotice } = await import('../src/cli.mjs');
  assert.equal(streamRestartNotice({ attempt: 1, limit: 3, kind: 'malformed-call' }), "[retry] The model's tool call could not be parsed; asking it to send the call again (1/3).");
  assert.equal(streamRestartNotice({ attempt: 1, limit: 2, reason: 'The model stream was interrupted: the connection closed' }, false), '[network] The model connection dropped mid-response; retrying (1/2).');
  assert.match(streamRestartNotice({ attempt: 2, limit: 3, reason: 'HTTP 503 high demand' }, true), /overloaded.*\(2\/3\)\. The partial reply above is discarded\./);
  assert.match(streamRestartNotice({ attempt: 1, reason: 'The model stream stalled: no data arrived for 120 seconds' }), /stalled/);
});

test('an empty glob result says so instead of printing nothing', async () => {
  const { describeToolResult } = await import('../src/terminal-ui.mjs');
  assert.equal(describeToolResult('glob_files', { pattern: '**/*.test.js', matches: [] }, { color: false }), '  ⎿ No files found');
  assert.equal(describeToolResult('glob_files', { pattern: '**/add.mjs', matches: ['add.mjs'] }, { color: false }), '  ⎿ 1 file');
});
