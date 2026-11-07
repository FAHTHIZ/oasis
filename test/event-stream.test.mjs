import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEvent, readEvents, clearEvents, eventLogPath } from '../src/event-stream.mjs';
import { mkdir, rm } from 'node:fs/promises';
import os from 'node:os';

async function makeTempRoot() {
  const root = os.tmpdir() + '/oasis-event-test-' + Date.now();
  await mkdir(root, { recursive: true });
  return root;
}

const env = { OASIS_CONFIG_DIR: '' };

test('append and read events roundtrip', async () => {
  const root = await makeTempRoot();
  const sessionId = 'abcdef1234567890abcd';
  await appendEvent(root, sessionId, { type: 'tool_call', tool: 'read_file', args: { path: 'src/a.js' } }, { env });
  await appendEvent(root, sessionId, { type: 'tool_result', tool: 'read_file', ok: true }, { env });
  const events = await readEvents(root, sessionId, { env });
  assert.equal(events.length, 2);
  assert.equal(events[0].seq, 0);
  assert.equal(events[1].seq, 1);
  assert.equal(events[0].type, 'tool_call');
  assert.equal(events[1].type, 'tool_result');
  await clearEvents(root, sessionId, { env });
  assert.equal((await readEvents(root, sessionId, { env })).length, 0);
  await rm(root, { recursive: true, force: true });
});

test('secrets are redacted in event payloads', async () => {
  const root = await makeTempRoot();
  const sessionId = 'abcdef1234567890abcd';
  await appendEvent(root, sessionId, { type: 'tool_call', tool: 'run_command', args: { command: 'curl -H "Authorization: Bearer sk-test1234567890"' } }, { env });
  const events = await readEvents(root, sessionId, { env });
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('sk-test1234567890'));
  await clearEvents(root, sessionId, { env });
  await rm(root, { recursive: true, force: true });
});

test('unknown event type is rejected', async () => {
  const root = await makeTempRoot();
  const sessionId = 'abcdef1234567890abcd';
  await assert.rejects(() => appendEvent(root, sessionId, { type: 'bogus' }, { env }), /Unknown event type/);
  await rm(root, { recursive: true, force: true });
});
