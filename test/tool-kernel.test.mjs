import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRegistry, defineTool, runTool } from '../src/tool-kernel.mjs';

const readTool = defineTool({ name: 'read_file', title: 'Read file', description: 'Read a file from the workspace.', capabilities: ['read'], risk: 'low', inputSchema: { required: ['path'] }, run: async (input) => ({ path: input.path, content: 'ok' }) });
const writeTool = defineTool({ name: 'write_file', title: 'Write file', description: 'Write a file in the workspace.', capabilities: ['write'], risk: 'high', requiresApproval: true, inputSchema: { required: ['path'] }, rollback: { supported: true, kind: 'file-snapshot' }, run: async (input) => ({ path: input.path, written: true }) });
const shellTool = defineTool({ name: 'run_command', title: 'Run command', description: 'Run a shell command.', capabilities: ['execute'], risk: 'critical', inputSchema: { required: ['command'] }, run: async (input) => ({ command: input.command, output: 'done' }) });

test('tool definitions validate capabilities and defaults', () => {
  assert.deepEqual(readTool.capabilities, ['read']);
  assert.equal(readTool.risk, 'low');
  assert.equal(writeTool.requiresApproval, true);
  assert.equal(writeTool.rollback.kind, 'file-snapshot');
  assert.throws(() => defineTool({ name: 'bad name', title: 'x', description: 'x', capabilities: ['read'], run: async () => {} }));
});

test('registry prevents duplicate tools and supports capability lookup', () => {
  const registry = createToolRegistry([readTool, writeTool, shellTool]);
  assert.equal(registry.has('read_file'), true);
  assert.equal(registry.get('missing'), null);
  assert.deepEqual(registry.byCapability('write').map((tool) => tool.name), ['write_file']);
  assert.throws(() => createToolRegistry([readTool, readTool]), /Duplicate tool name/);
});

test('policy deny blocks execution and records an audit event', async () => {
  const policy = { decide: () => ({ decision: 'deny', reason: 'not allowed' }) };
  const result = await runTool(readTool, { path: 'README.md' }, { policy });
  assert.equal(result.ok, false);
  assert.equal(result.decision.decision, 'deny');
  assert.equal(result.error, 'not allowed');
  assert.equal(result.audit.tool, 'read_file');
});

test('approval-required tools become pending approvals even if policy allows them', async () => {
  const policy = { decide: () => ({ decision: 'allow' }) };
  const result = await runTool(writeTool, { path: 'src/a.js' }, { policy });
  assert.equal(result.ok, false);
  assert.equal(result.pendingApproval, true);
  assert.equal(result.decision.decision, 'ask');
});

test('allowed tools execute and redact secrets in audit records', async () => {
  const policy = { decide: () => ({ decision: 'allow' }) };
  const result = await runTool(shellTool, { command: 'curl -H "Authorization: Bearer sk-secret-token-123456"' }, { policy });
  assert.equal(result.ok, true);
  assert.equal(result.output.output, 'done');
  assert.match(result.audit.input.command, /\[redacted\]/);
  assert.doesNotMatch(result.audit.input.command, /sk-secret-token-123456/);
});

test('missing required input fails without invoking the tool', async () => {
  const policy = { decide: () => ({ decision: 'allow' }) };
  const result = await runTool(readTool, {}, { policy });
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing required input/);
});
