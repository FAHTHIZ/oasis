import test from 'node:test';
import assert from 'node:assert/strict';
import { toolCallSlot } from '../src/agent.mjs';
import { chat } from '../app/core/providers.mjs';

const fn = (name, args) => ({ name, arguments: args });

function assemble(deltas) {
  const calls = new Map();
  for (const part of deltas) {
    const slot = toolCallSlot(calls, part);
    const tool = calls.get(slot) || { id: 'stream-tool-' + slot, function: { name: '', arguments: '' } };
    if (part.id) tool.id = part.id;
    if (part.function?.name) tool.function.name += part.function.name;
    if (part.function?.arguments) tool.function.arguments += part.function.arguments;
    calls.set(slot, tool);
  }
  return [...calls.values()].map((c) => c.id + ':' + c.function.name + ':' + c.function.arguments);
}

// Captured from Gemini's OpenAI endpoint: two parallel reads, each whole, no index.
test('Gemini parallel calls without an index stay separate', () => {
  assert.deepEqual(assemble([
    { id: 'call_1', type: 'function', function: fn('read_file', '{"path":"add.mjs"}') },
    { id: 'call_2', type: 'function', function: fn('read_file', '{"path":"test.mjs"}') }
  ]), ['call_1:read_file:{"path":"add.mjs"}', 'call_2:read_file:{"path":"test.mjs"}']);
});

test('OpenAI-style incremental deltas still assemble by index', () => {
  assert.deepEqual(assemble([
    { index: 0, id: 'a', function: fn('read_file', '') },
    { index: 0, function: { arguments: '{"pa' } },
    { index: 1, id: 'b', function: fn('list_files', '') },
    { index: 0, function: { arguments: 'th":"x"}' } },
    { index: 1, function: { arguments: '{}' } }
  ]), ['a:read_file:{"path":"x"}', 'b:list_files:{}']);
});

test('a gateway that numbers every call 0 still gets two calls', () => {
  assert.deepEqual(assemble([
    { index: 0, id: 'a', function: fn('read_file', '{"path":"1"}') },
    { index: 0, id: 'b', function: fn('read_file', '{"path":"2"}') }
  ]), ['a:read_file:{"path":"1"}', 'b:read_file:{"path":"2"}']);
});

test('the app splits Gemini parallel calls too', async () => {
  const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
  const body = sse({ choices: [{ delta: { role: 'assistant', tool_calls: [{ id: 'call_1', type: 'function', function: fn('read_file', '{"path":"add.mjs"}') }] }, index: 0 }] })
    + sse({ choices: [{ delta: { role: 'assistant', tool_calls: [{ id: 'call_2', type: 'function', function: fn('read_file', '{"path":"test.mjs"}') }] }, index: 0 }] })
    + sse({ choices: [{ delta: { role: 'assistant' }, finish_reason: 'stop', index: 0 }] }) + 'data: [DONE]\n\n';
  const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const reply = await chat({ protocol: 'openai-compatible', baseURL: 'https://example.test/v1', model: 'm', apiKey: 'k' }, { messages: [{ role: 'user', content: 'hi' }], tools: [], fetchImpl, onText: () => {} });
  const calls = reply.toolCalls || reply.tool_calls || [];
  assert.equal(calls.length, 2, JSON.stringify(reply));
});

// Captured from a live Pollinations (gpt-oss-20b) stream: the closing brace
// of call 0 arrived as index 1 with no id or name.
test('a stray fragment at a new index with no id or name continues the previous call', () => {
  assert.deepEqual(assemble([
    { index: 0, id: 'chatcmpl-tool-1', type: 'function', function: fn('read_file', '') },
    { index: 0, function: { arguments: '{"path":"a.mjs","limit":200' } },
    { index: 1, function: { arguments: '}' } }
  ]), ['chatcmpl-tool-1:read_file:{"path":"a.mjs","limit":200}']);
});

test('the app keeps a stray new-index fragment with the previous call', async () => {
  const sse = (obj) => 'data: ' + JSON.stringify(obj) + '\n\n';
  const body = sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: fn('read_file', '') }] }, index: 0 }] })
    + sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"a.mjs"' } }] }, index: 0 }] })
    + sse({ choices: [{ delta: { tool_calls: [{ index: 1, function: { arguments: '}' } }] }, index: 0 }] })
    + sse({ choices: [{ delta: {}, finish_reason: 'tool_calls', index: 0 }] }) + 'data: [DONE]\n\n';
  const fetchImpl = async () => new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const reply = await chat({ protocol: 'openai-compatible', baseURL: 'https://example.test/v1', model: 'm', apiKey: 'k' }, { messages: [{ role: 'user', content: 'hi' }], tools: [], fetchImpl, onText: () => {} });
  const calls = reply.toolCalls || reply.tool_calls || [];
  assert.equal(calls.length, 1, JSON.stringify(reply));
  assert.equal(calls[0].function.arguments, '{"path":"a.mjs"}');
});
