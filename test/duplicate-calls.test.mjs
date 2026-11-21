import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { duplicateSideEffectCalls } from '../src/duplicate-calls.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
const readOnly = (c) => ['read_file', 'grep'].includes(c.function.name);

test('identical adjacent side-effecting calls are flagged; key order and nulls do not matter', () => {
  const calls = [
    call('a', 'run_command', { command: 'git', args: ['commit', '-m', 'x'] }),
    call('b', 'run_command', { args: ['commit', '-m', 'x'], command: 'git', cwd: null }),
    call('c', 'read_file', { path: 'a' }),
    call('d', 'run_command', { command: 'git', args: ['commit', '-m', 'x'] })
  ];
  assert.deepEqual([...duplicateSideEffectCalls(calls, { isReadOnly: readOnly })], [['b', 'a'], ['d', 'a']]);
});

test('a different side effect in between makes the repeat deliberate', () => {
  const calls = [
    call('t1', 'run_command', { command: 'npm', args: ['test'] }),
    call('e', 'edit_file', { path: 'a.js', old_string: 'x', new_string: 'y' }),
    call('t2', 'run_command', { command: 'npm', args: ['test'] })
  ];
  assert.equal(duplicateSideEffectCalls(calls, { isReadOnly: readOnly }).size, 0);
});

test('read-only and unknown tools are never skipped', () => {
  const calls = [call('r1', 'read_file', { path: 'a' }), call('r2', 'read_file', { path: 'a' }), call('k1', 'browser', { action: 'press', key: 'Down' }), call('k2', 'browser', { action: 'press', key: 'Down' })];
  assert.equal(duplicateSideEffectCalls(calls, { isReadOnly: readOnly }).size, 0);
  assert.equal(duplicateSideEffectCalls([call('x', 'run_shell', '{bad'), call('y', 'run_shell', '{bad')]).size, 0);
});

test('a reply that appends twice in one go appends once', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-dupcalls-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = "require('fs').appendFileSync('log.txt', 'line\\n')";
  const twice = { content: null, tool_calls: [
    { id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: process.execPath, args: ['-e', script] }) } },
    { id: 'c2', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: process.execPath, args: ['-e', script] }) } }
  ] };
  const { config, requests } = await scriptedModel(t, [twice, { content: 'Appended.' }]);
  const session = await createSession({ root, config, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  await runAgentTurn(session, 'Append a line.', { approval: async () => true, autoApprove: true });
  assert.equal(await readFile(path.join(root, 'log.txt'), 'utf8'), 'line\n');
  const tools = requests[1].messages.filter((message) => message.role === 'tool');
  assert.equal(tools.length, 2);
  assert.match(String(tools[1].content), /identical to call c1/);
});
