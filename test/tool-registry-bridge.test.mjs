import test from 'node:test';
import assert from 'node:assert/strict';
import { bridgeToolDefinition, bridgeToolDefinitions } from '../src/tool-registry-bridge.mjs';

const readDefinition = { type: 'function', function: { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: {}, required: ['path'] } } };
const writeDefinition = { type: 'function', function: { name: 'write_file', description: 'Write a file.', parameters: { type: 'object', properties: {}, required: ['path', 'content'] } } };
const commandDefinition = { type: 'function', function: { name: 'run_command', description: 'Run a command.', parameters: { type: 'object', properties: {}, required: ['command', 'args'] } } };

test('bridge maps read tools to low-risk read capability', () => {
  const tool = bridgeToolDefinition(readDefinition);
  assert.equal(tool.name, 'read_file');
  assert.deepEqual(tool.capabilities, ['read']);
  assert.equal(tool.risk, 'low');
  assert.equal(tool.requiresApproval, false);
});

test('bridge maps write tools to high-risk write capability', () => {
  const tool = bridgeToolDefinition(writeDefinition);
  assert.deepEqual(tool.capabilities, ['write']);
  assert.equal(tool.risk, 'high');
  assert.equal(tool.rollback.kind, 'file-snapshot');
});

test('bridge marks command execution as approval-required', () => {
  const tool = bridgeToolDefinition(commandDefinition);
  assert.deepEqual(tool.capabilities, ['execute']);
  assert.equal(tool.risk, 'critical');
  assert.equal(tool.requiresApproval, true);
});

test('bridge converts a list of definitions', () => {
  const tools = bridgeToolDefinitions([readDefinition, writeDefinition, commandDefinition]);
  assert.equal(tools.length, 3);
  assert.equal(tools[0].name, 'read_file');
  assert.equal(tools[1].name, 'write_file');
  assert.equal(tools[2].name, 'run_command');
});
