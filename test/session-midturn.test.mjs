import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { completeExchanges, saveSession, loadSession, INTERRUPTED_TOOL_RESULT } from '../src/sessions.mjs';

const call = (id) => ({ id, type: 'function', function: { name: 'read_file', arguments: '{}' } });

test('completeExchanges answers every unanswered tool call so the transcript stays valid', () => {
  const base = [{ role: 'system', content: 's' }, { role: 'user', content: 'fix it' }];
  const done = [...base, { role: 'assistant', content: '', tool_calls: [call('a')] }, { role: 'tool', tool_call_id: 'a', content: 'ok' }];
  assert.deepEqual(completeExchanges(done), done);
  assert.deepEqual(completeExchanges(base), base);
  const step = { role: 'assistant', content: '', tool_calls: [call('b'), call('c')] };
  const pending = [...done, step, { role: 'tool', tool_call_id: 'b', content: 'ok' }];
  const fixed = completeExchanges(pending);
  assert.deepEqual(fixed.slice(0, pending.length), pending);
  assert.equal(fixed.length, pending.length + 1);
  assert.deepEqual(fixed.at(-1), { role: 'tool', tool_call_id: 'c', name: 'read_file', content: INTERRUPTED_TOOL_RESULT });
  // An assistant message whose calls cannot be answered (no id) is dropped.
  assert.deepEqual(completeExchanges([...done, { role: 'assistant', content: '', tool_calls: [{ type: 'function', function: { name: 'x' } }] }]), done);
});

test('completeExchanges keeps output from calls that finished before OASIS stopped', () => {
  const base = [{ role: 'system', content: 's' }, { role: 'user', content: 'deploy' }];
  const messages = [...base, { role: 'assistant', content: '', tool_calls: [call('w'), call('r')] }];
  const pendingOutputs = new Map([['w', { role: 'tool', tool_call_id: 'w', name: 'read_file', content: 'wrote 3 lines' }]]);
  const fixed = completeExchanges(messages, pendingOutputs);
  assert.equal(fixed.length, 5);
  assert.equal(fixed[3].tool_call_id, 'w');
  assert.match(fixed[3].content, /recovered[\s\S]*wrote 3 lines$/);
  assert.equal(fixed[4].tool_call_id, 'r');
  assert.equal(fixed[4].content, INTERRUPTED_TOOL_RESULT);
  assert.equal(messages.length, 3, 'the live transcript is not modified');
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
  assert.equal(messages.at(-1).tool_call_id, 'b');
  assert.equal(messages.at(-1).content, INTERRUPTED_TOOL_RESULT);
  assert.equal(messages.length, 6);
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

test('a session saved mid-turn is marked unfinished, and the next turn warns the model once', async (t) => {
  const { saveMidTurn, settleMidTurnSave } = await import('../src/sessions.mjs');
  const { createSession, runAgentTurn, closeSession } = await import('../src/agent.mjs');
  const { scriptedModel } = await import('./helpers/scripted-model.mjs');
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-midturn-mark-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(dir, 'cfg') };
  const live = { root: dir, sessionId: '0f1e2d3c-4b5a-4968-8776-655443322112', currentRequest: 'refactor the parser', config: { model: 'm' }, messages: [{ role: 'system', content: 's' }, { role: 'user', content: 'refactor the parser' }, { role: 'assistant', content: 'working' }] };
  saveMidTurn(live, { env, settleMs: 0 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await settleMidTurnSave(live);
  const restored = await loadSession(dir, live.sessionId, { env });
  assert.equal(restored.turnInProgress.request, 'refactor the parser');

  const { config, requests } = await scriptedModel(t, [{ content: 'checked' }]);
  const session = await createSession({ root: dir, config, restore: restored, env });
  t.after(() => closeSession && closeSession(session));
  await runAgentTurn(session, 'continue', { env });
  await runAgentTurn(session, 'and again', { env });
  const userText = (payload) => payload.messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
  const first = userText(requests[0]).at(-1);
  assert.match(first, /<interrupted-turn>OASIS stopped before your previous turn finished \(the request was: "refactor the parser"\)/);
  assert.match(first, /continue$/);
  assert.doesNotMatch(userText(requests.at(-1)).at(-1), /interrupted-turn/, 'the warning is given once');

  // A normal (end-of-turn) save clears the mark.
  await saveSession(session, { env });
  assert.equal((await loadSession(dir, session.sessionId, { env })).turnInProgress, null);
});
