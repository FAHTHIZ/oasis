// The browser app's agent: a reply cut off by the output token limit never
// runs the tool call that was still being written, and the model is told why.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, Workspace } from '../app/core/workspace.mjs';
import { Agent } from '../app/core/agent.mjs';
import { chat } from '../app/core/providers.mjs';

test('a tool call cut off by the output limit is not run', async () => {
  const ws = await Workspace.create(new MemoryStore(), { name: 'demo', files: [] });
  const seen = [];
  const replies = [
    { content: '', truncated: true, tool_calls: [{ id: '1', function: { name: 'write_file', arguments: '{"path":"big.js","content":"const a = 1;\\n' } }] },
    { content: '', tool_calls: [{ id: '2', function: { name: 'write_file', arguments: '{"path":"big.js","content":"const a = 1;\\n"}' } }] },
    { content: 'Wrote big.js.', tool_calls: [] }
  ];
  const events = [];
  const agent = new Agent({ getConfig: () => ({ mode: 'edits' }), getContext: () => ({ workspace: ws }), approve: async () => true, onEvent: (e) => events.push(e), chatImpl: async (config, request) => { seen.push(request.messages.map((m) => ({ ...m }))); return replies.shift() || { content: 'done', tool_calls: [] }; } });
  assert.equal(await agent.send('write big.js'), 'Wrote big.js.');
  const results = events.filter((e) => e.type === 'tool_result');
  assert.equal(results.length, 1, 'only the complete call ran');
  assert.ok(events.some((e) => e.type === 'truncated' && e.tool === 'write_file'));
  assert.match(seen[1].at(-1).content, /output token limit[\s\S]*write_file call was incomplete and was NOT run/);
  assert.equal(await ws.read('big.js'), 'const a = 1;\n');
});

test('providers report a reply cut off by the output limit', async () => {
  const sse = (events) => new Response(events.map((e) => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const openai = await chat({ protocol: 'openai', baseURL: 'http://p.test/v1', model: 'm' }, { messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => sse([{ choices: [{ delta: { content: 'part' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }, '[DONE]']) });
  assert.equal(openai.truncated, true);
  const anthropic = await chat({ protocol: 'anthropic', model: 'claude', apiKey: 'k' }, { messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => sse([{ type: 'message_start', message: { usage: { input_tokens: 1 } } }, { type: 'message_delta', delta: { stop_reason: 'max_tokens' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]) });
  assert.equal(anthropic.truncated, true);
});
