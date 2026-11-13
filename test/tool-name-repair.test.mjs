import test from 'node:test';
import assert from 'node:assert/strict';
import { repairToolName } from '../src/agent.mjs';

const known = new Set(['run_command', 'read_file', 'read_files', 'write_file', 'edit_file', 'run_shell']);

test('garbled tool names map to the registered tool they mean', () => {
  assert.equal(repairToolName('run_commandjson', known), 'run_command');
  assert.equal(repairToolName('functions.read_file', known), 'read_file');
  assert.equal(repairToolName('Write_File', known), 'write_file');
  assert.equal(repairToolName('edit_file<|call|>', known), 'edit_file');
  assert.equal(repairToolName(' "run_shell" ', known), 'run_shell');
  assert.equal(repairToolName('read_file{', known), 'read_file');
  assert.equal(repairToolName('write-file', known), 'write_file');
});

test('real and unrelated names are left alone', () => {
  assert.equal(repairToolName('read_files', known), 'read_files');
  assert.equal(repairToolName('run_commander', known), 'run_commander');
  assert.equal(repairToolName('git_init', known), 'git_init');
  assert.equal(repairToolName('', known), '');
});
