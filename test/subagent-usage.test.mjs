import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { summarizeAgent, normalizeAgentUsage } from '../src/agent-tasks.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { sanitizeAgentHistory } from '../src/sessions.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

// Parent requests report 100/10 tokens, child requests 7/3, so the two are easy to tell apart.
async function modelServer(t, { parent, child }) {
  const counts = { parent: 0, child: 0 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const isChild = payload.messages[0].content.includes('SUBAGENT MODE');
    counts[isChild ? 'child' : 'parent']++;
    const message = await (isChild ? child : parent)(payload, counts[isChild ? 'child' : 'parent']);
    if (message.fail) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'bad request from fixture' } })); return; }
    res.setHeader('content-type', 'application/json');
    const usage = isChild ? { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } : { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return { counts, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6 } };
}

async function until(check, ms = 5000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('foreground subagent usage is tagged with the agent and kept on its record', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-sub-usage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await modelServer(t, {
    parent: (payload) => payload.messages.at(-1).role === 'user' ? { content: null, tool_calls: [call('t1', 'task', { description: 'count files', prompt: 'count', subagent_type: 'explore' })] } : { content: 'done' },
    child: (payload, n) => n === 1 ? { content: null, tool_calls: [call('c1', 'list_files', { path: '.' })] } : { content: 'CHILD REPORT' }
  });
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  const events = [];
  const result = await runAgentTurn(session, 'start', { autoApprove: true, onUsage: (u) => events.push(u) });
  const child = events.filter((u) => u.subagent);
  assert.equal(child.length, 2);
  assert.ok(child.every((u) => u.agentId === 'agent_1' && u.agentType === 'explore' && u.subagent === 'count files'));
  assert.equal(events.filter((u) => !u.subagent && u.phase === undefined).length, 2);
  // Turn totals include the subagent's requests.
  assert.equal(result.taskUsage.inputTokens, 2 * 100 + 2 * 7);
  const record = session.agentTasks.agents.get('agent_1');
  assert.deepEqual({ ...record.usage, costUsd: 0 }, { requests: 2, inputTokens: 14, outputTokens: 6, totalTokens: 20, cacheReadTokens: 0, costUsd: 0, costKnown: true });
  assert.equal(summarizeAgent(record).usage.inputTokens, 14);
  // The task result tells the parent model what the agent cost.
  const toolMessage = session.messages.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /"usage":\{"requests":2,"inputTokens":14,"outputTokens":6/);
});

test('background subagent usage reaches the session sink and agent_status after the parent turn ends', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-sub-usage-bg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const { config } = await modelServer(t, {
    parent: (payload) => payload.messages.at(-1).role === 'user' && payload.messages.at(-1).content === 'start' ? { content: null, tool_calls: [call('t1', 'task', { description: 'bg audit', prompt: 'audit', subagent_type: 'explore', run_in_background: true })] } : { content: 'ok' },
    child: async () => { await held; return { content: 'BG REPORT' }; }
  });
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  const sink = [];
  session.onBackgroundUsage = (u) => sink.push(u);
  const turnEvents = [];
  await runAgentTurn(session, 'start', { autoApprove: true, onUsage: (u) => turnEvents.push(u) });
  release();
  const record = session.agentTasks.agents.get('agent_1');
  await until(() => record.status === 'completed');
  assert.equal(turnEvents.filter((u) => u.subagent).length, 0, 'background usage does not land in the finished turn');
  assert.equal(sink.length, 1);
  assert.equal(sink[0].agentId, 'agent_1');
  assert.equal(sink[0].background, true);
  assert.equal(sink[0].inputTokens, 7);
  assert.equal(record.usage.requests, 1);
  assert.equal(record.tokensUsed, 10);
  assert.equal(summarizeAgent(record).usage.outputTokens, 3);
  const detail = await runBuiltinCommand('tasks', 'agent_1', { root, session });
  assert.match(detail.output, /1 requests, 7 in \/ 3 out tokens/);
  // Saved and restored with the session.
  const [saved] = sanitizeAgentHistory(session.agentTasks);
  assert.equal(saved.usage.inputTokens, 7);
  assert.deepEqual(normalizeAgentUsage(saved.usage), saved.usage);
});

test('a failed subagent keeps the tokens it spent before failing', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-sub-usage-fail-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config } = await modelServer(t, {
    parent: (payload) => payload.messages.at(-1).role === 'user' ? { content: null, tool_calls: [call('t1', 'task', { description: 'flaky', prompt: 'go', subagent_type: 'explore' })] } : { content: 'done' },
    child: (payload, n) => n === 1 ? { content: null, tool_calls: [call('c1', 'list_files', { path: '.' })] } : { fail: true }
  });
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'start', { autoApprove: true });
  const record = session.agentTasks.agents.get('agent_1');
  assert.ok(['failed', 'completed'].includes(record.status), record.status);
  assert.equal(record.usage.requests, 1);
  assert.equal(record.tokensUsed, 10);
});
