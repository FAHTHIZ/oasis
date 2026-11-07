import test from 'node:test';
import assert from 'node:assert/strict';
import {
  openAIEndpoint, responsesEndpoint, anthropicEndpoint,
  toResponsesRequest, toAnthropicRequest, chatCompletionTool
} from '../src/provider-requests.mjs';

test('provider endpoint builders preserve complete endpoints and append missing paths', () => {
  assert.equal(openAIEndpoint('https://api.example/v1'), 'https://api.example/v1/chat/completions');
  assert.equal(openAIEndpoint('https://api.example/v1/chat/completions'), 'https://api.example/v1/chat/completions');
  assert.equal(responsesEndpoint('https://api.example/v1/'), 'https://api.example/v1/responses');
  assert.equal(responsesEndpoint('https://api.example/v1/responses'), 'https://api.example/v1/responses');
  assert.equal(anthropicEndpoint('https://api.example'), 'https://api.example/v1/messages');
  assert.equal(anthropicEndpoint('https://api.example/v1'), 'https://api.example/v1/messages');
  assert.equal(anthropicEndpoint('https://api.example/v1/messages'), 'https://api.example/v1/messages');
});

test('Responses serialization preserves system instructions, tool calls and tool results', () => {
  const request = toResponsesRequest([
    { role: 'system', content: 'Follow the project rules.' },
    { role: 'user', content: 'Read a file.' },
    { role: 'assistant', content: 'I will inspect it.', tool_calls: [
      { id: 'call-1', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }
    ] },
    { role: 'tool', tool_call_id: 'call-1', content: 'Project overview.' },
    { role: 'assistant', content: 'The file describes the project.' }
  ]);
  assert.equal(request.instructions, 'Follow the project rules.');
  assert.deepEqual(request.input, [
    { role: 'user', content: 'Read a file.' },
    { role: 'assistant', content: 'I will inspect it.' },
    { type: 'function_call', call_id: 'call-1', name: 'read_file', arguments: '{"path":"README.md"}' },
    { type: 'function_call_output', call_id: 'call-1', output: 'Project overview.' },
    { role: 'assistant', content: 'The file describes the project.' }
  ]);
});

test('Responses serialization replays provider response items without lossy reconstruction', () => {
  const responseItems = [
    { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'Checked the plan.' }] },
    { type: 'function_call', call_id: 'call-2', name: 'read_file', arguments: '{}' }
  ];
  const request = toResponsesRequest([
    { role: 'assistant', content: 'hidden reasoning', responseItems, tool_calls: [{ id: 'ignored', function: { name: 'ignored', arguments: '{}' } }] }
  ]);
  assert.deepEqual(request.input, responseItems);
});

test('Anthropic serialization preserves signed thinking blocks and groups tool results', () => {
  const thinking = { type: 'thinking', thinking: 'I should inspect the result.', signature: 'signed-fixture' };
  const request = toAnthropicRequest([
    { role: 'system', content: 'Be careful.' },
    { role: 'user', content: 'Read two files.' },
    { role: 'assistant', content: 'Reading.', thinkingBlocks: [thinking], tool_calls: [
      { id: 'call-1', function: { name: 'read_file', arguments: '{"path":"a"}' } }
    ] },
    { role: 'tool', tool_call_id: 'call-1', content: 'A' },
    { role: 'tool', tool_call_id: 'call-2', content: 'B' },
    { role: 'assistant', content: '   ' }
  ], { thinking: true });
  assert.equal(request.system, 'Be careful.');
  assert.deepEqual(request.messages[0], { role: 'user', content: 'Read two files.' });
  assert.deepEqual(request.messages[1].content[0], thinking);
  assert.deepEqual(request.messages[1].content.find((block) => block.type === 'tool_use').input, { path: 'a' });
  assert.deepEqual(request.messages[2].content.map((block) => block.type), ['tool_result', 'tool_result']);
  assert.deepEqual(request.messages[2].content.map((block) => block.tool_use_id), ['call-1', 'call-2']);
  assert.equal(request.messages[3].content, '(empty reply)');
});

test('chat-completions tool projection strips unsupported outer and function properties', () => {
  const tool = {
    type: 'function',
    function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' }, strict: true, provider_extension: true },
    provider_extension: true
  };
  assert.deepEqual(chatCompletionTool(tool), {
    type: 'function',
    function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object' }, strict: true }
  });
  const other = { type: 'custom', payload: true };
  assert.equal(chatCompletionTool(other), other);
});
