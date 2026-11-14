import test from 'node:test';
import assert from 'node:assert/strict';
import { wireToolCallIds, toolCallIdStyle } from '../src/tool-call-ids.mjs';
import { toAnthropicRequest } from '../src/provider-requests.mjs';

const call = (id, name = 'read_file') => ({ id, type: 'function', function: { name, arguments: '{}' } });
const step = (...ids) => [{ role: 'assistant', content: '', tool_calls: ids.map((id) => call(id)) }, ...ids.map((id) => ({ role: 'tool', tool_call_id: id, content: 'ok ' + id }))];

test('valid unique IDs pass through and the same array is returned', () => {
  const messages = [{ role: 'system', content: 's' }, { role: 'user', content: 'u' }, ...step('toolu_01', 'call_abc')];
  assert.equal(wireToolCallIds(messages), messages);
});

test('IDs repeated on later steps become unique and results follow their own call', () => {
  const messages = [{ role: 'user', content: 'u' }, ...step('stream-tool-0'), ...step('stream-tool-0')];
  const wire = wireToolCallIds(messages);
  const ids = wire.filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls.map((c) => c.id));
  assert.equal(new Set(ids).size, 2);
  assert.equal(wire[2].tool_call_id, ids[0]);
  assert.equal(wire[4].tool_call_id, ids[1]);
  assert.equal(messages[3].tool_calls[0].id, 'stream-tool-0', 'the transcript is not modified');
  // Deterministic, so the request prefix stays stable for prompt caching.
  assert.deepEqual(wireToolCallIds(messages), wire);
  assert.deepEqual(wireToolCallIds(messages.slice(0, 3)), wire.slice(0, 3));
});

test('IDs another provider rejects are rewritten for every provider style', () => {
  const messages = [{ role: 'user', content: 'u' }, ...step('functions.bash:0', 'x'.repeat(64))];
  const wire = wireToolCallIds(messages);
  for (const c of wire[1].tool_calls) assert.match(c.id, /^[A-Za-z0-9_-]{1,40}$/);
  assert.equal(wire[2].tool_call_id, wire[1].tool_calls[0].id);
  assert.equal(wire[3].tool_call_id, wire[1].tool_calls[1].id);
  const anthropic = toAnthropicRequest([{ role: 'system', content: 's' }, ...wire]);
  const uses = anthropic.messages.flatMap((m) => Array.isArray(m.content) ? m.content : []).filter((b) => b.type === 'tool_use');
  for (const block of uses) assert.match(block.id, /^[A-Za-z0-9_-]+$/);
  const mistral = wireToolCallIds(messages, { style: 'mistral' });
  for (const c of mistral[1].tool_calls) assert.match(c.id, /^[A-Za-z0-9]{9}$/);
  assert.equal(mistral[3].tool_call_id, mistral[1].tool_calls[1].id);
});

test('duplicate IDs inside one message map to their results in order', () => {
  const messages = [{ role: 'user', content: 'u' }, { role: 'assistant', content: '', tool_calls: [call('c0'), call('c0')] }, { role: 'tool', tool_call_id: 'c0', content: 'a' }, { role: 'tool', tool_call_id: 'c0', content: 'b' }];
  const wire = wireToolCallIds(messages);
  const [first, second] = wire[1].tool_calls.map((c) => c.id);
  assert.notEqual(first, second);
  assert.equal(wire[2].tool_call_id, first);
  assert.equal(wire[3].tool_call_id, second);
});

test('replayed Responses API items are left untouched', () => {
  const messages = [{ role: 'user', content: 'u' }, { role: 'assistant', content: '', tool_calls: [call('call_1')], responseItems: [{ type: 'function_call', call_id: 'call_1' }] }, { role: 'tool', tool_call_id: 'call_1', content: 'ok' }];
  assert.equal(wireToolCallIds(messages), messages);
});

test('Mistral is recognised from its endpoint', () => {
  assert.equal(toolCallIdStyle({ baseURL: 'https://api.mistral.ai/v1' }), 'mistral');
  assert.equal(toolCallIdStyle({ baseURL: 'https://api.openai.com/v1' }), 'generic');
  assert.equal(toolCallIdStyle({}), 'generic');
});
