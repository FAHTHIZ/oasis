import test from 'node:test';
import assert from 'node:assert/strict';
import {
  labelToolActivity,
  safeToolActivityArgs,
  toolActivityArtifacts,
  toolActivityCategory,
  toolActivityStatus,
  toolActivityWarning
} from '../src/tool-activity.mjs';

test('tool activity labels use plain language for common file, edit, command and search tools', () => {
  assert.equal(labelToolActivity('read_file', { path: 'src/math.mjs' }), 'Read math.mjs');
  assert.equal(labelToolActivity('edit_file', { path: 'src/math.mjs' }), 'Edited math.mjs');
  assert.equal(labelToolActivity('multi_edit', { path: 'src/math.mjs' }), 'Edited math.mjs');
  assert.equal(labelToolActivity('run_command', { command: 'npm', args: ['test'] }), 'Ran the tests');
  assert.equal(labelToolActivity('search_files', { query: 'add' }), "Searched for 'add'");
});

test('tool activity labels cover tools without a model-authored narration', () => {
  assert.equal(labelToolActivity('write_file', { path: 'notes.txt' }), 'Wrote notes.txt');
  assert.equal(labelToolActivity('glob_files', { pattern: 'src/**/*.mjs' }), 'Found files matching src/**/*.mjs');
  assert.equal(labelToolActivity('repo_map'), 'Mapped the project files');
  assert.equal(labelToolActivity('run_command', { command: 'node', args: ['--version'] }), 'Ran a command');
});

test('tool activity categories group common actions without exposing tool names', () => {
  assert.equal(toolActivityCategory('read_file'), 'read');
  assert.equal(toolActivityCategory('edit_file'), 'edit');
  assert.equal(toolActivityCategory('write_file'), 'write');
  assert.equal(toolActivityCategory('delete_file'), 'delete');
  assert.equal(toolActivityCategory('run_command'), 'command');
  assert.equal(toolActivityCategory('search_files'), 'search');
  assert.equal(toolActivityCategory('an_unknown_tool'), 'other');
});

test('tool activity details redact secrets before the browser receives arguments', () => {
  const safe = safeToolActivityArgs({
    path: 'src/math.mjs',
    command: 'node',
    token: 'super-secret-value',
    args: ['--api-key=private-value']
  });
  assert.equal(safe.path, 'src/math.mjs');
  assert.doesNotMatch(JSON.stringify(safe), /super-secret-value|private-value/);
  assert.match(JSON.stringify(safe), /\[redacted\]/);
});

test('failed commands, warnings, timeouts and tool errors produce visible warnings', () => {
  assert.match(toolActivityWarning({ exitCode: 1, output: 'Assertion failed' }), /failed \(exit code 1\)/i);
  assert.match(toolActivityWarning({ error: 'File could not be read' }), /could not be read/i);
  assert.match(toolActivityWarning({ warning: 'Verification incomplete' }), /Verification incomplete/);
  assert.match(toolActivityWarning({ exitCode: 0, stdout: 'Warning: the compiler skipped a check.' }), /Warning: the compiler skipped a check/);
  assert.match(toolActivityWarning({ exitCode: 0, output: 'Tests weakened in 1 place.' }), /Tests weakened/);
  assert.match(toolActivityWarning({ timedOut: true }), /timed out/i);
  assert.equal(toolActivityWarning({ exitCode: 0, output: 'ok' }), '');
});


test('activity receipts distinguish successful, warned and failed tool outcomes', () => {
  assert.equal(toolActivityStatus({ exitCode: 0, output: 'All checks passed' }), 'success');
  assert.equal(toolActivityStatus({ warning: 'One optional check was unavailable' }), 'warning');
  assert.equal(toolActivityStatus({ approved: false, message: 'User denied the edit' }), 'warning');
  assert.equal(toolActivityStatus({ exitCode: 2, output: 'Typecheck failed' }), 'error');
  assert.equal(toolActivityStatus({ error: 'File not found' }), 'error');
});

test('successful file writes and edits create safe inline preview metadata only after a real change', () => {
  assert.deepEqual(
    toolActivityArtifacts('write_file', { path: 'src/new-module.mjs' }, {
      path: 'src/new-module.mjs', writtenBytes: 42, backedUpExistingFile: false
    }),
    [{ path: 'src/new-module.mjs', action: 'created' }]
  );
  assert.deepEqual(
    toolActivityArtifacts('write_file', { path: 'src/module.mjs' }, {
      path: 'src/module.mjs', writtenBytes: 42, backedUpExistingFile: true
    }),
    [{ path: 'src/module.mjs', action: 'updated' }]
  );
  assert.deepEqual(
    toolActivityArtifacts('edit_file', { path: 'src/module.mjs' }, {
      path: 'src/module.mjs', changed: true, replacements: 1
    }),
    [{ path: 'src/module.mjs', action: 'updated' }]
  );
  assert.deepEqual(toolActivityArtifacts('edit_file', { path: 'src/module.mjs' }, {
    path: 'src/module.mjs', changed: false
  }), []);
  assert.deepEqual(toolActivityArtifacts('write_file', { path: 'src/blocked.mjs' }, {
    error: 'Write was blocked'
  }), []);
  assert.deepEqual(toolActivityArtifacts('run_command', { command: 'npm', args: ['test'] }, {
    exitCode: 0
  }), []);
});
