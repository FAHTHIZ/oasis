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
  await writeFile(path.join(directory, id + '.json'), ' '.repeat(3 * 1024 * 1024 + 1));
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
