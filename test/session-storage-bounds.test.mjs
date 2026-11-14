import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { getSessionDirectory, loadSession, listSessions, saveSession, sanitizeAgentHistory } from '../src/sessions.mjs';

async function fixture(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), 'oasis-session-bounds-'));
  const root = path.join(base, 'workspace');
  const env = { ...process.env, OASIS_CONFIG_DIR: path.join(base, 'config') };
  await mkdir(root);
  t.after(() => rm(base, { recursive: true, force: true }));
  return { base, root, env };
}

function payload(root, id) {
  return {
    schemaVersion: 1,
    id,
    workspaceRoot: path.resolve(root),
    updatedAt: new Date().toISOString(),
    provider: { model: 'fixture' },
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'hello' }]
  };
}

test('loadSession rejects oversized files and session listings skip oversized entries', async (t) => {
  const { root, env } = await fixture(t);
  const id = '0123456789abcdef01234567';
  const directory = getSessionDirectory(root, env);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, id + '.json'), ' '.repeat(64 * 1024 * 1024 + 1));
  await assert.rejects(loadSession(root, id, { env }), /Stored session is too large/);
  assert.deepEqual(await listSessions(root, { env }), []);
});

test('loadSession refuses symlinked session files and listings omit them', { skip: process.platform === 'win32' }, async (t) => {
  const { root, env, base } = await fixture(t);
  const id = 'abcdef0123456789abcdef01';
  const directory = getSessionDirectory(root, env);
  await mkdir(directory, { recursive: true });
  const outside = path.join(base, 'outside.json');
  await writeFile(outside, JSON.stringify(payload(root, id)));
  await symlink(outside, path.join(directory, id + '.json'));
  await assert.rejects(loadSession(root, id, { env }), /regular, non-symlink/);
  assert.deepEqual(await listSessions(root, { env }), []);
});

test('saved agent history is bounded, redacted and excludes live execution state', () => {
  const agents = sanitizeAgentHistory({ agents: new Map([
    ['agent_1', {
      id: 'agent_1', type: 'general-purpose', description: 'Check provider setup',
      status: 'running', background: true, startedAt: 100, runs: 2, toolCalls: 8,
      tokensUsed: 1200, recentTools: ['read_file', 'run_command'],
      report: 'Found key sk-ant-abcdefghijklmnop123456 and fixed the setup.',
      child: { messages: [{ role: 'user', content: 'PRIVATE CHILD PROMPT' }], background: new Map([['secret-process', {}]]) },
      controller: new AbortController(), promise: Promise.resolve()
    }],
    ['agent_2', { id: 'not-an-agent', status: 'completed' }]
  ]) });
  assert.equal(agents.length, 1);
  assert.equal(agents[0].id, 'agent_1');
  assert.equal(agents[0].status, 'running');
  assert.match(agents[0].report, /\[redacted\]/i);
  assert.doesNotMatch(JSON.stringify(agents), /PRIVATE CHILD PROMPT|secret-process|sk-ant-abcdefghijklmnop123456/);
  assert.equal(Object.hasOwn(agents[0], 'child'), false);
  assert.equal(Object.hasOwn(agents[0], 'controller'), false);
});

test('session save/load preserves bounded agent reports without persisting child conversations', async (t) => {
  const { root, env } = await fixture(t);
  const id = '0123456789abcdef0123456789abcdef';
  const session = {
    root, sessionId: id,
    config: { protocol: 'openai-compatible', baseURL: 'http://localhost', model: 'fixture-model' },
    messages: [{ role: 'system', content: 'system' }, { role: 'user', content: 'Inspect the API.' }],
    todos: [], mustPreserve: [], sharedTasks: null,
    agentTasks: { agents: new Map([
      ['agent_1', { id: 'agent_1', type: 'general-purpose', description: 'Inspect API contracts', status: 'running', startedAt: 100, runs: 1, toolCalls: 4, report: 'Observed API shape.', child: { messages: [{ role: 'user', content: 'CHILD-ONLY PRIVATE PROMPT' }], background: new Map([['private-process', {}]]) } }],
      ['agent_2', { id: 'agent_2', type: 'explore', description: 'Completed review', status: 'completed', startedAt: 80, finishedAt: 90, runs: 1, toolCalls: 2, report: 'No API mismatch found.' }]
    ]) }
  };
  await saveSession(session, { env });
  const raw = await readFile(path.join(getSessionDirectory(root, env), id + '.json'), 'utf8');
  assert.doesNotMatch(raw, /CHILD-ONLY PRIVATE PROMPT|private-process/);
  const restored = await loadSession(root, id, { env });
  assert.equal(restored.agents.length, 2);
  assert.equal(restored.agents[0].status, 'running');
  assert.equal(restored.agents[0].report, 'Observed API shape.');
  assert.equal(restored.agents[1].status, 'completed');
  assert.equal(Object.hasOwn(restored.agents[0], 'child'), false);
});

test('a 2,600-step turn is saved whole and resumable', async (t) => {
  const { root, env } = await fixture(t);
  // More than 5,000 messages with no user message in the tail: once cut to a count cap, now kept whole.
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'earlier task' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'refactor everything' }];
  for (let i = 0; i < 2600; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: 'call_' + i, name: 'read_file', content: 'ok ' + i });
  }
  const saved = await saveSession({ root, messages, config: {} }, { env });
  const loaded = await loadSession(root, saved.id, { env });
  assert.equal(loaded.messages.length, messages.length);
  assert.equal(loaded.messages[0].role, 'system');
  assert.deepEqual(loaded.messages[3], { role: 'user', content: 'refactor everything' });
  assert.deepEqual(loaded.messages.at(-1), messages.at(-1));
  // Every kept tool result answers a kept tool call, so providers accept the resume.
  const calls = new Set(loaded.messages.flatMap((m) => (m.tool_calls || []).map((c) => c.id)));
  for (const m of loaded.messages.filter((item) => item.role === 'tool')) assert.ok(calls.has(m.tool_call_id), m.tool_call_id);
});

test('a long agentic turn is saved whole, not cut to the last 120 messages', async (t) => {
  const { root, env } = await fixture(t);
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'first task' }, { role: 'assistant', content: 'done' }, { role: 'user', content: 'refactor everything' }];
  for (let i = 0; i < 300; i++) {
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: 'call_' + i, name: 'read_file', content: 'ok ' + i });
  }
  messages.push({ role: 'assistant', content: 'finished' });
  const saved = await saveSession({ root, messages, config: {} }, { env });
  const loaded = await loadSession(root, saved.id, { env });
  assert.equal(loaded.messages.length, messages.length);
  assert.deepEqual(loaded.messages[1], { role: 'user', content: 'first task' });
});

test('a reply with more than 30 parallel tool calls still saves', async (t) => {
  const { root, env } = await fixture(t);
  const calls = Array.from({ length: 48 }, (_, i) => ({ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }));
  const messages = [{ role: 'system', content: 'system' }, { role: 'user', content: 'read all of them' }, { role: 'assistant', content: null, tool_calls: calls }, ...calls.map((c) => ({ role: 'tool', tool_call_id: c.id, name: 'read_file', content: 'ok' }))];
  const saved = await saveSession({ root, messages, config: {} }, { env });
  const loaded = await loadSession(root, saved.id, { env });
  assert.equal(loaded.messages[2].tool_calls.length, 48);
});

test('a session over the byte cap is saved with its oldest exchanges dropped', async (t) => {
  const { root, env } = await fixture(t);
  const big = 'x'.repeat(4 * 1024 * 1024);
  const messages = [{ role: 'system', content: 'system' }];
  for (let i = 0; i < 20; i++) messages.push({ role: 'user', content: 'task ' + i + ' ' + big }, { role: 'assistant', content: 'answer ' + i });
  const saved = await saveSession({ root, messages, config: {} }, { env });
  const loaded = await loadSession(root, saved.id, { env });
  assert.ok(loaded.messages.length < messages.length, 'something was dropped');
  assert.ok(loaded.messages.length > 3, 'but not everything');
  assert.equal(loaded.messages[0].role, 'system');
  assert.equal(loaded.messages[1].role, 'user');
  assert.deepEqual(loaded.messages.at(-1), messages.at(-1), 'the newest exchange is kept');
});

test('a long session keeps its whole history: no message-count cap below the byte cap', async (t) => {
  const { root, env } = await fixture(t);
  const messages = [{ role: 'system', content: 'system' }];
  for (let i = 0; i < 4000; i++) {
    messages.push({ role: 'user', content: 'step ' + i });
    messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + i, type: 'function', function: { name: 'read_file', arguments: '{}' } }] });
    messages.push({ role: 'tool', tool_call_id: 'c' + i, content: 'ok ' + i });
  }
  const session = { root, messages, config: { model: 'fixture' } };
  await saveSession(session, { env });
  const loaded = await loadSession(root, session.sessionId, { env });
  assert.equal(loaded.messages.length, messages.length);
  assert.equal(loaded.messages[1].content, 'step 0');
});
