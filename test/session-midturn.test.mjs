import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { completeExchanges, saveSession, loadSession } from '../src/sessions.mjs';

const call = (id) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } });

test('completeExchanges drops a tool call whose results have not all arrived', () => {
  const base = [{ role: 'system', content: 's' }, { role: 'user', content: 'fix it' }];
  const done = [...base, { role: 'assistant', content: '', tool_calls: [call('a')] }, { role: 'tool', tool_call_id: 'a', content: 'ok' }];
  assert.deepEqual(completeExchanges(done), done);
  const pending = [...done, { role: 'assistant', content: '', tool_calls: [call('b'), call('c')] }, { role: 'tool', tool_call_id: 'b', content: 'ok' }];
  assert.deepEqual(completeExchanges(pending), done);
  assert.deepEqual(completeExchanges(base), base);
});

// A turn interrupted mid-task (closed terminal, crash) is saved as it goes and
// resumes without a dangling tool call the provider would reject.
test('a session saved mid-turn loads back as a valid transcript', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-midturn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'cfg') };
  const session = { root: dir, config: { model: 'm' }, messages: [
    { role: 'system', content: 's' }, { role: 'user', content: 'fix it' },
    { role: 'assistant', content: '', tool_calls: [call('a')] }, { role: 'tool', tool_call_id: 'a', content: 'ok' },
    { role: 'assistant', content: '', tool_calls: [call('b')] }
  ] };
  const saved = await saveSession(session, { env });
  const loaded = await loadSession(dir, saved.id, { env });
  const messages = loaded.messages || loaded.session?.messages;
  assert.equal(messages.at(-1).role, 'tool');
  assert.equal(messages.length, 4);
});

test('saveMidTurn trails the step, throttles snapshots, and settleMidTurnSave waits for the last one', async (t) => {
  const { saveMidTurn, settleMidTurnSave } = await import('../src/sessions.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-midturn-throttle-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'cfg') };
  const session = { root: dir, sessionId: '0f1e2d3c-4b5a-4968-8776-655443322111', config: { model: 'm' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'one' }] };
  saveMidTurn(session, { env, intervalMs: 60_000, settleMs: 20 });
  const timer = session.midTurnTimer;
  saveMidTurn(session, { env, intervalMs: 60_000, settleMs: 20 });
  assert.equal(session.midTurnTimer, timer, 'a pending save is not repeated');
  // The step lands in history after the callback; the trailing save sees it.
  session.messages.push({ role: 'assistant', content: 'two' });
  await new Promise((resolve) => setTimeout(resolve, 60));
  await session.midTurnSave;
  let loaded = await loadSession(dir, session.sessionId, { env });
  assert.equal((loaded.messages || loaded.session.messages).length, 3);
  session.messages.push({ role: 'user', content: 'three' });
  saveMidTurn(session, { env, intervalMs: 60_000, settleMs: 20 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(session.midTurnTimer, 'a save inside the interval is deferred');
  await settleMidTurnSave(session);
  assert.equal(session.midTurnTimer, null, 'settling cancels the deferred save');
  loaded = await loadSession(dir, session.sessionId, { env });
  assert.equal((loaded.messages || loaded.session.messages).length, 3, 'the deferred snapshot never ran');
});
