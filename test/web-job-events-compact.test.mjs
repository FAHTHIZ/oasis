import test from 'node:test';
import assert from 'node:assert/strict';
import { compactJobEvents } from '../src/web.mjs';

test('old streamed deltas merge so earlier steps survive the event cap', () => {
  const events = [{ id: 1, type: 'tool_start', data: { name: 'write_file' } }];
  for (let i = 0; i < 200; i += 1) events.push({ id: i + 2, type: 'assistant_delta', data: { text: 'x' } });
  events.push({ id: 202, type: 'tool_end', data: {} });
  compactJobEvents(events, 120, 20);
  assert.equal(events[0].type, 'tool_start');
  assert.ok(events.length <= 120);
  const text = events.filter((e) => e.type === 'assistant_delta').map((e) => e.data.text).join('');
  assert.equal(text.length, 200);
  assert.equal(events.at(-1).id, 202);
  // Ids stay increasing so ?after= keeps working.
  for (let i = 1; i < events.length; i += 1) assert.ok(events[i].id > events[i - 1].id);
});
