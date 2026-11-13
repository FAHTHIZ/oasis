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

test('a long call cut off inside a string explains how to split it', async () => {
  const { repairToolArguments } = await import('../src/tool-call-repair.mjs');
  const raw = JSON.stringify({ path: 'a.html', content: 'x'.repeat(2000) }).slice(0, 1500);
  assert.throws(() => repairToolArguments(raw), /cut off after 1500 characters[\s\S]*append: true/);
  assert.throws(() => repairToolArguments('{"path":"a","content":"ab'), /not valid JSON/);
});
