import test from 'node:test';
import assert from 'node:assert/strict';
import { repairInterruptedHistory } from '../src/agent.mjs';

test('interrupted history gets results for unanswered tool calls and a closing note', () => {
  const session = { messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'do it' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { id: 'b', type: 'function', function: { name: 'run_command', arguments: '{}' } }
    ] },
    { role: 'tool', tool_call_id: 'a', name: 'read_file', content: 'ok' }
  ] };
  assert.equal(repairInterruptedHistory(session), 2);
  assert.deepEqual(session.messages.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'assistant']);
  assert.equal(session.messages[4].tool_call_id, 'b');
  assert.match(session.messages[4].content, /Interrupted/);
  assert.equal(repairInterruptedHistory(session), 0);
});

test('a trailing user message without a reply is closed', () => {
  const session = { messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'hi' }] };
  assert.equal(repairInterruptedHistory(session), 1);
  assert.equal(session.messages.at(-1).role, 'assistant');
  const fresh = { messages: [{ role: 'system', content: 's' }] };
  assert.equal(repairInterruptedHistory(fresh), 0);
});

test('repair drops tool results that answer no preceding call and sends no extra fields', () => {
  const session = { messages: [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'read two' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      { id: 'c2', type: 'function', function: { name: 'read_file', arguments: '{}' } }
    ] },
    { role: 'tool', tool_call_id: 'c1', name: 'read_file', content: 'A' },
    { role: 'user', content: 'continue' },
    // Arrived after the exchange was closed (late result, or a truncated save):
    // OpenAI, Responses and Anthropic all reject a result with no matching call.
    { role: 'tool', tool_call_id: 'c2', name: 'read_file', content: 'late' },
    { role: 'tool', tool_call_id: 'zz', name: 'read_file', content: 'orphan' },
    { role: 'assistant', content: 'ok' }
  ] };
  assert.ok(repairInterruptedHistory(session) >= 3);
  assert.deepEqual(session.messages.map((m) => m.role + (m.tool_call_id ? ':' + m.tool_call_id : '')), ['system', 'user', 'assistant', 'tool:c1', 'tool:c2', 'user', 'assistant']);
  for (const message of session.messages) assert.equal('result' in message, false, 'only wire fields go to the provider');
  assert.equal(repairInterruptedHistory(session), 0);
});
