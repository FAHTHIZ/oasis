import test from 'node:test';
import assert from 'node:assert/strict';
import { appendEvent, readEvents, clearEvents } from '../src/event-stream.mjs';
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

test('concurrent appends allocate unique ordered sequence numbers', async () => {
  const root = await makeTempRoot();
  const sessionId = 'abcdef1234567890abcd';
  await Promise.all(Array.from({ length: 40 }, (_, index) =>
    appendEvent(root, sessionId, { type: 'tool_result', index }, { env })
  ));
  const events = await readEvents(root, sessionId, { env });
  assert.equal(events.length, 40);
  assert.deepEqual(events.map((event) => event.seq), Array.from({ length: 40 }, (_, index) => index));
  assert.deepEqual(events.map((event) => event.index).sort((a, b) => a - b), Array.from({ length: 40 }, (_, index) => index));
  await clearEvents(root, sessionId, { env });
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

test('event logs redact short credentials in named fields and CLI argument pairs', async () => {
  const root = await makeTempRoot();
  const sessionId = 'abcdef1234567890abcd';
  await appendEvent(root, sessionId, {
    type: 'tool_call',
    tool: 'run_command',
    args: {
      command: 'deploy --token plainEventCommandCredential --region ap-southeast-1',
      args: ['--api-key', 'plainEventArgCredential', '--limit', '10'],
      headers: { authorization: 'Bearer plainEventHeaderCredential' }
    }
  }, { env });
  const serialized = JSON.stringify(await readEvents(root, sessionId, { env }));
  assert.doesNotMatch(serialized, /plainEventCommandCredential|plainEventArgCredential|plainEventHeaderCredential/);
  assert.match(serialized, /ap-southeast-1/);
  assert.match(serialized, /--limit/);
  await clearEvents(root, sessionId, { env });
  await rm(root, { recursive: true, force: true });
});

test('a saved session records tool calls, results and approvals, shows them in oasis sessions events, and deleting the session removes them', async (t) => {
  const path = (await import('node:path')).default;
  const { mkdtemp } = await import('node:fs/promises');
  const { scriptedModel, toolCall } = await import('./helpers/scripted-model.mjs');
  const { createSession, closeSession, runAgentTurn } = await import('../src/agent.mjs');
  const { saveSession, deleteSession } = await import('../src/sessions.mjs');
  const { formatAuditEvent } = await import('../src/cli-sessions.mjs');
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-audit-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-audit-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const env = { ...process.env, OASIS_CONFIG_DIR: home, OASIS_SANDBOX: '0' };
  const { config } = await scriptedModel(t, [toolCall('call_1', 'run_command', { command: process.execPath, args: ['-e', 'process.exit(3)'] }), { content: 'done' }]);
  const session = await createSession({ root, config: { ...config, maxSteps: 4 }, env });
  t.after(() => closeSession(session));
  await saveSession(session, { env });
  const asked = [];
  await runAgentTurn(session, 'run it', { env, approval: async (message) => { asked.push(message); return true; } });
  let events = [];
  for (let i = 0; i < 50 && !events.some((e) => e.type === 'tool_result'); i += 1) {
    events = await readEvents(root, session.sessionId, { env });
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const call = events.find((e) => e.type === 'tool_call');
  const result = events.find((e) => e.type === 'tool_result');
  assert.equal(call.tool, 'run_command');
  assert.match(call.input, /process\.exit\(3\)/);
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  if (asked.length) assert.ok(events.some((e) => e.type === 'approval' && e.allowed === true));
  assert.ok(call.seq < result.seq, 'events are in order');
  assert.match(formatAuditEvent(result), /tool_result run_command failed \(exit 3\)/);
  await saveSession(session, { env });
  await deleteSession(root, session.sessionId, { env });
  assert.deepEqual(await readEvents(root, session.sessionId, { env }), []);
});
