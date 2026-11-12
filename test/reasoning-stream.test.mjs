import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { readProviderStream } from '../src/provider-stream.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { compactJobEvents } from '../src/web.mjs';
import { buildTimeline, thoughtLabel } from '../app/core/timeline.mjs';

const sseChunks = (frames) => new Response(frames.map((frame) => (frame.event ? 'event: ' + frame.event + '\n' : '') + 'data: ' + (typeof frame.data === 'string' ? frame.data : JSON.stringify(frame.data)) + '\n\n').join(''), { headers: { 'content-type': 'text/event-stream' } });

test('reasoning streams through onReasoning for Chat, Anthropic and Responses streams', async () => {
  const chat = [];
  await readProviderStream(sseChunks([
    { data: { choices: [{ delta: { reasoning_content: 'Looking at ' } }] } },
    { data: { choices: [{ delta: { reasoning: 'the parser.' } }] } },
    { data: { choices: [{ delta: { content: 'Done.' } }] } },
    { data: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
    { data: '[DONE]' }
  ]), 'openai-compatible', () => {}, null, (chunk) => chat.push(chunk));
  assert.deepEqual(chat, ['Looking at ', 'the parser.']);

  const anthropic = [];
  await readProviderStream(sseChunks([
    { event: 'message_start', data: { type: 'message_start', message: { id: 'm', usage: { input_tokens: 1 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Planning the edit.' } } },
    // display: omitted sends an empty thinking delta: nothing is shown.
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '' } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
    { event: 'message_stop', data: { type: 'message_stop' } }
  ]), 'anthropic', () => {}, null, (chunk) => anthropic.push(chunk));
  assert.deepEqual(anthropic, ['Planning the edit.']);

  const responses = [];
  await readProviderStream(sseChunks([
    { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', delta: 'First part.' } },
    { event: 'response.reasoning_summary_part.added', data: { type: 'response.reasoning_summary_part.added', summary_index: 1 } },
    { event: 'response.reasoning_summary_text.delta', data: { type: 'response.reasoning_summary_text.delta', delta: 'Second part.' } },
    { event: 'response.completed', data: { type: 'response.completed', response: { status: 'completed', output: [] } } }
  ]), 'openai-responses', () => {}, null, (chunk) => responses.push(chunk));
  assert.deepEqual(responses, ['First part.', '\n\n', 'Second part.']);
});

async function scriptedServer(t, handler) {
  const bodies = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw || '{}'));
    await handler(req, res, bodies.length - 1);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { base: 'http://127.0.0.1:' + server.address().port, bodies };
}

async function turn(t, config, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-reasoning-'));
  const session = await createSession({ root, config: { apiKey: 'test-key', configured: true, maxSteps: 4, maxToolCalls: 4, maxTokens: 100000, ...config }, permissionMode: 'bypassPermissions', bare: true });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  const shown = [];
  const result = await runAgentTurn(session, 'think hard about it', { env: { ...process.env, ...(options.env || {}) }, onDelta: () => {}, onReasoning: (text) => shown.push(text) });
  return { result, shown };
}

test('the agent shows redacted, capped reasoning and asks OpenAI Responses for a summary', async (t) => {
  const secret = 'sk-proj-' + 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6';
  const { base, bodies } = await scriptedServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (data) => res.write('event: ' + data.type + '\ndata: ' + JSON.stringify(data) + '\n\n');
    send({ type: 'response.reasoning_summary_text.delta', delta: 'The key is ' + secret + '. ' });
    send({ type: 'response.reasoning_summary_text.delta', delta: 'x'.repeat(20000) });
    send({ type: 'response.output_text.delta', delta: 'All set.' });
    send({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'All set.' }] }], usage: { input_tokens: 3, output_tokens: 2 } } });
    res.end();
  });
  const { result, shown } = await turn(t, { protocol: 'openai-responses', baseURL: base + '/v1', model: 'gpt-5-mini' });
  assert.equal(result.text, 'All set.');
  assert.deepEqual(bodies[0].reasoning && bodies[0].reasoning.summary, 'auto');
  assert.ok(shown.length >= 1);
  const last = shown.at(-1);
  assert.ok(!last.includes(secret), 'the secret is redacted');
  assert.match(last, /The key is \[redacted\]/);
  assert.ok(last.length <= 8000, 'reasoning shown is capped');
});

test('a model that sends no reasoning shows none, and no summary is asked of a non-reasoning model', async (t) => {
  const { base, bodies } = await scriptedServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('event: response.output_text.delta\ndata: ' + JSON.stringify({ type: 'response.output_text.delta', delta: 'Hi.' }) + '\n\n');
    res.end('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: 'Hi.' }] }] } }) + '\n\n');
  });
  const { shown } = await turn(t, { protocol: 'openai-responses', baseURL: base + '/v1', model: 'gpt-4o' });
  assert.deepEqual(shown, []);
  assert.equal(bodies[0].reasoning, undefined);
});

test('Anthropic thinking asks for the summarized display and streams it', async (t) => {
  const { base, bodies } = await scriptedServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const ev = (obj) => res.write('event: ' + obj.type + '\ndata: ' + JSON.stringify(obj) + '\n\n');
    ev({ type: 'message_start', message: { id: 'm', model: 'claude-opus-4-8', usage: { input_tokens: 3 } } });
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Weighing two designs.' } });
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig' } });
    ev({ type: 'content_block_stop', index: 0 });
    ev({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } });
    ev({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Use the second.' } });
    ev({ type: 'content_block_stop', index: 1 });
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } });
    ev({ type: 'message_stop' });
    res.end();
  });
  const { result, shown } = await turn(t, { protocol: 'anthropic', baseURL: base, model: 'claude-opus-4-8' }, { env: { OASIS_THINKING_BUDGET: '4096' } });
  assert.equal(result.text, 'Use the second.');
  assert.equal(bodies[0].thinking && bodies[0].thinking.display, 'summarized');
  assert.deepEqual(shown, ['Weighing two designs.']);
});

test('leading <think> text from a local model is shown as reasoning, not as the reply', async (t) => {
  const { base } = await scriptedServer(t, (req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const piece of ['<think>Check ', 'the file.</think>', 'Here it is.']) res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: piece } }] }) + '\n\n');
    res.write('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\n');
    res.end('data: [DONE]\n\n');
  });
  const { result, shown } = await turn(t, { protocol: 'openai-compatible', baseURL: base + '/v1', model: 'local' });
  assert.equal(result.text, 'Here it is.');
  assert.equal(shown.at(-1), 'Check the file.');
});

test('reasoning deltas fold together in old job events, and a reset starts a new block', () => {
  const events = [];
  let id = 1;
  const push = (type, data) => events.push({ id: id++, type, data });
  push('reasoning_delta', { text: 'a', reset: true });
  push('reasoning_delta', { text: 'b' });
  push('tool_start', { callId: 'x' });
  push('reasoning_delta', { text: 'c', reset: true });
  push('reasoning_delta', { text: 'd' });
  for (let index = 0; index < 30; index++) push('usage', {});
  compactJobEvents(events, 4000, 20);
  const reasoning = events.filter((event) => event.type === 'reasoning_delta').map((event) => event.data);
  assert.deepEqual(reasoning, [{ text: 'ab', reset: true }, { text: 'cd', reset: true }]);
});

test('saved reasoning becomes its own block between the work before and after it', () => {
  const blocks = buildTimeline([
    { role: 'user', content: 'go' },
    { role: 'assistant', content: '', tools: [{ id: 'a', name: 'read_file' }] },
    { role: 'assistant', content: '', reasoning: { text: 'The parser splits on spaces.', ms: 4200 }, tools: [{ id: 'b', name: 'edit_file' }] },
    { role: 'assistant', content: 'Fixed.', tools: [] }
  ]);
  assert.deepEqual(blocks.map((block) => block.type), ['user', 'group', 'reasoning', 'group', 'text']);
  assert.equal(thoughtLabel(4200), 'Thought for 4s');
  assert.equal(thoughtLabel(NaN), 'Thought');
});
