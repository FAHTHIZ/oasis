import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolRunner } from '../src/tool-runner.mjs';

const handlers = [
  {
    name: 'read_file',
    title: 'Read file',
    description: 'Read a file.',
    capabilities: ['read'],
    risk: 'low',
    inputSchema: { required: ['path'] },
    run: async (input) => ({ path: input.path, content: 'ok' })
  },
  {
    name: 'write_file',
    title: 'Write file',
    description: 'Write a file.',
    capabilities: ['write'],
    risk: 'high',
    requiresApproval: true,
    inputSchema: { required: ['path'] },
    run: async (input) => ({ path: input.path, written: true })
  }
];

test('tool runner executes allowed tools', async () => {
  const runner = createToolRunner(handlers, { policy: { decide: () => ({ decision: 'allow' }) } });
  const result = await runner.run('read_file', { path: 'README.md' });
  assert.equal(result.ok, true);
  assert.equal(result.output.content, 'ok');
});

test('tool runner denies unknown tools', async () => {
  const runner = createToolRunner(handlers, { policy: { decide: () => ({ decision: 'allow' }) } });
  const result = await runner.run('missing_tool', {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown tool/);
});

test('tool runner respects policy denial', async () => {
  const runner = createToolRunner(handlers, { policy: { decide: () => ({ decision: 'deny', reason: 'not allowed' }) } });
  const result = await runner.run('read_file', { path: 'README.md' });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not allowed');
});

test('tool runner requires approval for write tools', async () => {
  const runner = createToolRunner(handlers, { policy: { decide: () => ({ decision: 'allow' }) } });
  const result = await runner.run('write_file', { path: 'src/a.js' });
  assert.equal(result.ok, false);
  assert.equal(result.pendingApproval, true);
});

test('tool runner validates required input', async () => {
  const runner = createToolRunner(handlers, { policy: { decide: () => ({ decision: 'allow' }) } });
  const result = await runner.run('read_file', {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Missing required input/);
});
