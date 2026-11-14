// Property test: whatever shape an interrupted or imported history has, after
// repair every tool call is answered right after it, no tool result is
// orphaned, and the IDs sent to the provider are unique.
import test from 'node:test';
import assert from 'node:assert/strict';
import { repairInterruptedHistory } from '../src/tool-results.mjs';
import { wireToolCallIds } from '../src/tool-call-ids.mjs';

function rng(seed) {
  let state = seed;
  return () => (state = (state * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
}

function randomHistory(random) {
  const pick = (list) => list[Math.floor(random() * list.length)];
  const messages = [{ role: 'system', content: 's' }];
  let open = [];
  const length = 1 + Math.floor(random() * 12);
  for (let i = 0; i < length; i++) {
    const r = random();
    if (r < 0.25) messages.push({ role: 'user', content: 'u' + i });
    else if (r < 0.5) {
      open = Array.from({ length: 1 + Math.floor(random() * 3) }, (_, j) => pick(['a', 'b', 'stream-tool-0', 'functions.bash:' + j, '']));
      messages.push({ role: 'assistant', content: '', tool_calls: open.map((id) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } })) });
    } else if (r < 0.8) messages.push({ role: 'tool', tool_call_id: open.length ? pick(open) : pick(['a', 'z']), content: 'r' });
    else messages.push({ role: 'assistant', content: 'text' });
  }
  return messages;
}

function problem(messages) {
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'tool') {
      let j = i - 1;
      while (j >= 0 && messages[j].role === 'tool') j--;
      const owner = messages[j];
      if (!owner || owner.role !== 'assistant' || !(owner.tool_calls || []).some((call) => call.id === message.tool_call_id)) return 'orphan result at ' + i;
    }
    if (message.role === 'assistant' && Array.isArray(message.tool_calls) && message.tool_calls.length) {
      const answered = [];
      for (let j = i + 1; j < messages.length && messages[j].role === 'tool'; j++) answered.push(messages[j].tool_call_id);
      if (new Set(answered).size !== answered.length) return 'duplicate result at ' + i;
      for (const call of message.tool_calls) if (!call.id || !answered.includes(call.id)) return 'unanswered call at ' + i;
    }
  }
  return null;
}

test('repaired histories are always valid provider transcripts', () => {
  const random = rng(7);
  for (let run = 0; run < 3000; run++) {
    const original = randomHistory(random);
    const session = { messages: structuredClone(original) };
    repairInterruptedHistory(session);
    assert.equal(problem(session.messages), null, JSON.stringify(original));
    const wire = wireToolCallIds(session.messages);
    assert.equal(problem(wire), null, JSON.stringify(original));
    const ids = wire.flatMap((message) => message.role === 'assistant' && Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => call.id) : []);
    assert.equal(new Set(ids).size, ids.length, JSON.stringify(original));
    for (const id of ids) assert.match(id, /^[A-Za-z0-9_-]{1,40}$/);
  }
});
