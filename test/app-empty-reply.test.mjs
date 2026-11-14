// The browser app's agent: an empty reply is asked again (twice), then
// reported, and a content-filter stop is reported without re-asking.
import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryStore, Workspace } from '../app/core/workspace.mjs';
import { Agent } from '../app/core/agent.mjs';
import { chat } from '../app/core/providers.mjs';
import { EMPTY_REPLY_NOTICE, EMPTY_REPLY_NUDGE } from '../src/empty-reply.mjs';

async function run(replies) {
  const ws = await Workspace.create(new MemoryStore(), { name: 'demo', files: [] });
  const seen = [];
  const events = [];
  const agent = new Agent({ getConfig: () => ({ mode: 'edits' }), getContext: () => ({ workspace: ws }), approve: async () => true, onEvent: (e) => events.push(e),
    chatImpl: async (_config, request) => { seen.push(request.messages.map((m) => ({ ...m }))); return replies[Math.min(seen.length - 1, replies.length - 1)]; } });
  const answer = await agent.send('do it');
  return { answer, seen, events };
}

test('an empty reply is asked again and the real answer is kept', async () => {
  const { answer, seen, events } = await run([{ content: '', tool_calls: [] }, { content: 'Done.', tool_calls: [] }]);
  assert.equal(answer, 'Done.');
  assert.equal(seen.length, 2);
  assert.equal(seen[1].at(-1).content, EMPTY_REPLY_NUDGE);
  assert.ok(events.some((e) => e.type === 'empty_reply'));
});

test('repeated empty replies end with a notice instead of nothing', async () => {
  const { answer, seen } = await run([{ content: '  ', tool_calls: [] }]);
  assert.equal(seen.length, 3);
  assert.equal(answer, EMPTY_REPLY_NOTICE);
});

test('a content-filter stop is reported without asking again', async () => {
  const { answer, seen } = await run([{ content: '', tool_calls: [], providerStop: 'content_filter' }]);
  assert.equal(seen.length, 1);
  assert.match(answer, /finish reason: content_filter/);
});

test('providers report content_filter and refusal stops', async () => {
  const sse = (events) => new Response(events.map((e) => 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n').join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const openai = await chat({ protocol: 'openai', baseURL: 'http://p.test/v1', model: 'm' }, { messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => sse([{ choices: [{ delta: {}, finish_reason: 'content_filter' }] }, '[DONE]']) });
  assert.equal(openai.providerStop, 'content_filter');
  const anthropic = await chat({ protocol: 'anthropic', model: 'claude', apiKey: 'k' }, { messages: [{ role: 'user', content: 'x' }], fetchImpl: async () => sse([
    { type: 'message_start', message: { usage: { input_tokens: 1 } } },
    { type: 'message_delta', delta: { stop_reason: 'refusal' }, usage: { output_tokens: 0 } },
    { type: 'message_stop' }
  ]) });
  assert.equal(anthropic.providerStop, 'refusal');
});
