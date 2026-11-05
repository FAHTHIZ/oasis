import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { PermissionPolicy } from '../src/permissions.mjs';
import { compactHistoryIfNeeded } from '../src/agent.mjs';
import { idleCompactMinutes, idleCompactThreshold, startIdleCompaction, idleCompactionNote, historyChars, DEFAULT_IDLE_COMPACT_MINUTES } from '../src/idle-compaction.mjs';

function conversation(turns, size = 2000) {
  const messages = [{ role: 'system', content: 'system prompt' }];
  for (let i = 0; i < turns; i++) {
    messages.push({ role: 'user', content: 'question ' + i + ' ' + 'q'.repeat(size) });
    messages.push({ role: 'assistant', content: 'answer ' + i + ' ' + 'a'.repeat(size) });
  }
  return messages;
}

function fakeTimers() {
  const timers = [];
  return { timers, setTimer: (fn, ms) => { const timer = { fn, ms, cleared: false }; timers.push(timer); return timer; }, clearTimer: (timer) => { if (timer) timer.cleared = true; }, fire: () => timers.forEach((timer) => !timer.cleared && timer.fn()) };
}

test('idle compaction minutes come from the environment, then settings, then the default', () => {
  assert.equal(idleCompactMinutes({}, {}), DEFAULT_IDLE_COMPACT_MINUTES);
  assert.equal(idleCompactMinutes({ idleCompactMinutes: 5 }, {}), 5);
  assert.equal(idleCompactMinutes({ idleCompactMinutes: 0 }, {}), 0);
  assert.equal(idleCompactMinutes({ idleCompactMinutes: 5 }, { OASIS_IDLE_COMPACT_MINUTES: 'off' }), 0);
  assert.equal(idleCompactMinutes({}, { OASIS_IDLE_COMPACT_MINUTES: '30' }), 30);
  assert.equal(idleCompactMinutes({}, { OASIS_IDLE_COMPACT_MINUTES: '99999' }), 1440);
});

test('small conversations, or auto-compaction off, are never compacted while idle', () => {
  const config = { protocol: 'openai-compatible', model: 'fixture' };
  assert.equal(idleCompactThreshold({ config, messages: conversation(3) }, {}), 0);
  const big = { config, messages: conversation(30) };
  assert.ok(historyChars(big.messages) > 100_000);
  assert.ok(idleCompactThreshold(big, {}) > 0);
  assert.equal(idleCompactThreshold(big, { OASIS_AUTOCOMPACT_PCT: '0' }), 0);
});

test('the idle timer compacts once with a lowered threshold and reports it', async () => {
  const session = { config: {}, messages: conversation(30) };
  const timers = fakeTimers(); const calls = [];
  const idle = startIdleCompaction(session, { minutes: 15, env: {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer, compact: async (target, options) => { calls.push(options); return { compacted: true, beforeTokens: 40000, afterTokens: 6000 }; } });
  assert.equal(timers.timers[0].ms, 15 * 60_000);
  timers.fire();
  const result = await idle.settle();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].discardOnAbort, true);
  assert.ok(calls[0].thresholdChars > 0);
  assert.match(idleCompactionNote(result), /While you were away[\s\S]*~40k → ~6k tokens[\s\S]*\/compact undo/);
});

test('typing before the timer fires cancels it; typing during a summary aborts it', async () => {
  const session = { config: {}, messages: conversation(30) };
  const early = fakeTimers(); let called = 0;
  const idle = startIdleCompaction(session, { minutes: 15, env: {}, setTimer: early.setTimer, clearTimer: early.clearTimer, compact: async () => { called++; return { compacted: true }; } });
  assert.equal(await idle.settle(), null);
  assert.equal(early.timers[0].cleared, true);
  assert.equal(called, 0);

  const mid = fakeTimers(); let sawAbort = false;
  const running = startIdleCompaction(session, { minutes: 15, env: {}, setTimer: mid.setTimer, clearTimer: mid.clearTimer, compact: (target, options) => new Promise((resolve) => options.signal.addEventListener('abort', () => { sawAbort = true; resolve({ compacted: false, cancelled: true }); })) });
  mid.fire();
  assert.equal(running.state.status, 'running');
  assert.equal(await running.settle(), null);
  assert.equal(sawAbort, true);
  assert.equal(running.state.status, 'cancelled');
  assert.equal(startIdleCompaction(session, { minutes: 0, compact: async () => ({}) }).state.status, 'waiting');
});

async function fixtureSession(t, respond) {
  const server = createServer(async (req, res) => { for await (const _ of req) {} respond(res); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-idle-'));
  const env = { ...process.env, HOME: root, OASIS_CONFIG_DIR: path.join(root, 'cfg') };
  const session = { root, sessionId: randomUUID(), config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '' }, messages: conversation(30), mustPreserve: [], permissions: new PermissionPolicy({ permissions: {} }), hooks: {} };
  return { session, env };
}

test('a real idle compaction summarizes older turns and keeps the recent ones', async (t) => {
  const { session, env } = await fixtureSession(t, (res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'IDLE SUMMARY' } }] })); });
  const threshold = idleCompactThreshold(session, env);
  assert.ok(threshold > 0);
  const before = session.messages.length;
  const result = await compactHistoryIfNeeded(session, { env, thresholdChars: threshold, discardOnAbort: true, signal: new AbortController().signal, persistSessionNotes: false });
  assert.equal(result.compacted, true);
  assert.ok(session.messages.length < before);
  assert.match(JSON.stringify(session.messages), /IDLE SUMMARY/);
  assert.match(JSON.stringify(session.messages.at(-1)), /answer 29/);
});

test('an aborted idle compaction leaves the history untouched', async (t) => {
  let hold;
  const { session, env } = await fixtureSession(t, (res) => { hold = res; });
  const original = JSON.stringify(session.messages);
  const controller = new AbortController();
  const pending = compactHistoryIfNeeded(session, { env, thresholdChars: 40_000, discardOnAbort: true, signal: controller.signal, persistSessionNotes: false });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  if (hold) hold.destroy();
  assert.equal(result.compacted, false);
  assert.equal(result.cancelled, true);
  assert.equal(JSON.stringify(session.messages), original);
});
