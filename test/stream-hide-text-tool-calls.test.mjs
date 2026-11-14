import test from 'node:test';
import assert from 'node:assert/strict';
import { hideStreamingToolCalls as hide } from '../src/tool-call-repair.mjs';

const names = new Set(['read_file', 'write_file']);

// Regression: with qwen3:0.6b on Ollama the terminal printed the model's raw
// `<tools>{"name": "read_file", …}</tools>` markup while streaming, then the
// recovered Read(math.mjs) step under it.
test('streaming text stops at a text-format tool call', () => {
  assert.equal(hide("I'll check math.mjs.\n<tools>\n{\"name\": \"read_file\", \"arguments\": {\"path\": \"math.mjs\"}}\n</tools>", names), "I'll check math.mjs.");
  assert.equal(hide('Reading.\n<tool_call>\n{"name": "read_file"', names), 'Reading.');
  assert.equal(hide('Reading. <function=read_file><parameter=path>a</parameter></function>', names), 'Reading.');
  assert.equal(hide('x [TOOL_CALLS]read_file[ARGS]{}', names), 'x');
  assert.equal(hide('Let me read.\n{"name": "read_file", "arguments": {}}', names), 'Let me read.');
});

test('a marker still arriving is held back, then released if it is not one', () => {
  assert.equal(hide('Checking.\n<too', names), 'Checking.\n');
  assert.equal(hide('Let me read.\n{"name": "rea', names), 'Let me read.');
  assert.equal(hide('a < b holds.', names), 'a < b holds.');
});

test('quoted markup and ordinary JSON stay visible', () => {
  const fenced = 'Example:\n```\n<tool_call>{}</tool_call>\n```\nDone.';
  assert.equal(hide(fenced, names), fenced);
  const pkg = 'package.json:\n{"name": "my-package", "version": "1.0.0"}';
  assert.equal(hide(pkg, names), pkg);
  assert.equal(hide('plain reply', names), 'plain reply');
});
