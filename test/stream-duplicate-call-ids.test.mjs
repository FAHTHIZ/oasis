import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { readProviderStream, toolCallSlot, uniqueToolCallIds } from '../src/provider-stream.mjs';
import { scriptedModel } from './helpers/scripted-model.mjs';

function sse(events) {
  const text = events.map((event) => 'data: ' + (typeof event === 'string' ? event : JSON.stringify(event)) + '\n\n').join('');
  return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }));
}

test('parallel streamed calls that reuse one id stay separate calls with distinct ids', async () => {
  const reply = await readProviderStream(sse([
    { choices: [{ delta: { tool_calls: [
      { index: 0, id: 'x', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      { index: 1, id: 'x', type: 'function', function: { name: 'list_files', arguments: '{}' } }
    ] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }, '[DONE]'
  ]), 'openai-compatible', () => {});
  const calls = reply.choices[0].message.tool_calls;
  assert.deepEqual(calls.map((call) => call.function.name), ['read_file', 'list_files']);
  assert.deepEqual(calls.map((call) => call.function.arguments), ['{"path":"a.txt"}', '{}']);
  assert.deepEqual(calls.map((call) => call.id), ['x', 'x_2']);
});

test('an id-only continuation still appends to its call', () => {
  const calls = new Map([[0, { id: 'a', function: { name: 'read_file', arguments: '{"pa' } }]]);
  assert.equal(toolCallSlot(calls, { index: 0, id: 'a', function: { arguments: 'th":1}' } }), 0);
  assert.equal(toolCallSlot(calls, { id: 'a', function: { arguments: '' } }), 0);
});

test('uniqueToolCallIds leaves distinct ids alone', () => {
  assert.deepEqual(uniqueToolCallIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }, { id: 'a' }]).map((call) => call.id), ['a', 'b', 'a_2', 'a_3']);
});

test('a non-streamed reply with duplicate call ids runs both calls and answers each by its own id', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-dup-ids-'));
  await writeFile(path.join(root, 'a.txt'), 'hello\n');
  const model = await scriptedModel(t, [
    { content: null, tool_calls: [
      { id: 'x', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
      { id: 'x', type: 'function', function: { name: 'list_files', arguments: '{}' } }
    ] },
    { content: 'Done.' }
  ]);
  const session = await createSession({ root, config: model.config, permissionMode: 'bypassPermissions', env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: root } });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  const result = await runAgentTurn(session, 'Look around.', { onDelta() {}, onText() {} });
  assert.equal(result.text, 'Done.');
  const second = model.requests[1].messages;
  const assistant = second.find((message) => message.role === 'assistant' && message.tool_calls);
  assert.deepEqual(assistant.tool_calls.map((call) => call.id), ['x', 'x_2']);
  const results = second.filter((message) => message.role === 'tool').map((message) => message.tool_call_id);
  assert.deepEqual(results.sort(), ['x', 'x_2']);
});
