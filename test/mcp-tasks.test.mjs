import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { useMcpTask, mcpTaskBackgroundMs } from '../src/mcp-project.mjs';
import { McpServerClient } from '../src/mcp.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

// A stdio MCP server with task support (MCP 2025-11-25). "slow" requires a task
// and finishes after a few polls; "plain" forbids tasks; "doomed" fails.
const SERVER = String.raw`
let buffer = ''; const tasks = new Map(); let seq = 0; const log = [];
process.stdin.setEncoding('utf8');
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
const now = () => new Date().toISOString();
const view = (t) => ({ taskId: t.id, status: t.status, createdAt: t.created, lastUpdatedAt: now(), ttl: t.ttl ?? null, pollInterval: 50, ...(t.message ? { statusMessage: t.message } : {}) });
process.stdin.on('data', (chunk) => { buffer += chunk; let i;
  while ((i = buffer.indexOf('\n')) >= 0) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id === undefined) continue;
    log.push(m.method + (m.params && m.params.task ? '+task' : ''));
    if (m.method === 'initialize') reply(m.id, { protocolVersion: '2025-11-25', serverInfo: { name: 'jobs', version: '1' }, capabilities: { tools: {}, tasks: { cancel: {}, list: {}, requests: { tools: { call: {} } } } } });
    else if (m.method === 'tools/list') reply(m.id, { tools: [
      { name: 'slow', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
      { name: 'doomed', inputSchema: { type: 'object' }, execution: { taskSupport: 'optional' } },
      { name: 'plain', inputSchema: { type: 'object' } },
      { name: 'forever', inputSchema: { type: 'object' }, execution: { taskSupport: 'required' } },
      { name: 'log', inputSchema: { type: 'object' } }] });
    else if (m.method === 'tools/call' && m.params.name === 'log') reply(m.id, { content: [{ type: 'text', text: 'LOG ' + log.join(',') }] });
    else if (m.method === 'tools/call' && m.params.task) {
      if (m.params.name === 'plain') { fail(m.id, -32601, 'no tasks for plain'); continue; }
      const t = { id: 'task-' + (++seq), name: m.params.name, status: 'working', polls: 0, created: now(), ttl: m.params.task.ttl ?? 60000 };
      tasks.set(t.id, t); reply(m.id, { task: view(t) }); }
    else if (m.method === 'tools/call') {
      if (m.params.name === 'slow') { fail(m.id, -32601, 'slow requires a task'); continue; }
      reply(m.id, { content: [{ type: 'text', text: 'plain-result' }] }); }
    else if (m.method === 'tasks/get') { const t = tasks.get(m.params.taskId); t.polls++;
      if (t.name !== 'forever' && t.polls >= 3 && t.status === 'working') { t.status = t.name === 'doomed' ? 'failed' : 'completed'; t.message = t.name === 'doomed' ? 'disk full' : undefined; }
      reply(m.id, view(t)); }
    else if (m.method === 'tasks/result') { const t = tasks.get(m.params.taskId);
      reply(m.id, { content: [{ type: 'text', text: t.name === 'doomed' ? 'job failed: disk full' : 'slow-result after ' + t.polls + ' polls' }], isError: t.name === 'doomed', _meta: { 'io.modelcontextprotocol/related-task': { taskId: t.id } } }); }
    else if (m.method === 'tasks/cancel') { const t = tasks.get(m.params.taskId); t.status = 'cancelled'; reply(m.id, view(t)); }
    else reply(m.id, {}); } });
`;

async function tmp(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-mcptask-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function sessionWithServer(t, steps) {
  const root = await tmp(t);
  const home = await tmp(t);
  await writeFile(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { jobs: { command: process.execPath, args: ['-e', SERVER] } } }));
  const env = { ...process.env, OASIS_CONFIG_DIR: home, HOME: home };
  await setWorkspaceTrust(root, true, env);
  const { config, requests } = await scriptedModel(t, steps);
  const session = await createSession({ root, config, env });
  t.after(() => closeSession(session));
  return { session, requests };
}
const toolTexts = (requests, index) => requests[index].messages.filter((m) => m.role === 'tool').map((m) => m.content);

test('task augmentation follows server capability and tool taskSupport', () => {
  const caps = { tasks: { requests: { tools: { call: {} } } } };
  assert.equal(useMcpTask({ capabilities: caps }, { execution: { taskSupport: 'required' } }), true);
  assert.equal(useMcpTask({ capabilities: caps }, { execution: { taskSupport: 'optional' } }), true);
  assert.equal(useMcpTask({ capabilities: caps }, { execution: { taskSupport: 'forbidden' } }), false);
  assert.equal(useMcpTask({ capabilities: caps }, {}), false);
  assert.equal(useMcpTask({ capabilities: { tools: {} } }, { execution: { taskSupport: 'required' } }), false);
});

test('task-required MCP tools run as tasks: create, poll tasks/get, read tasks/result', async (t) => {
  const { session, requests } = await sessionWithServer(t, [
    toolCall('c1', 'mcp_jobs_slow', {}),
    toolCall('c2', 'mcp_jobs_plain', {}),
    toolCall('c3', 'mcp_jobs_doomed', {}),
    toolCall('c4', 'mcp_jobs_log', {}),
    { content: 'done' }
  ]);
  await runAgentTurn(session, 'run the jobs', { autoApprove: true });
  const [slow] = toolTexts(requests, 1);
  assert.match(slow, /slow-result after 3 polls/);
  assert.match(toolTexts(requests, 2)[1], /plain-result/);
  const doomed = toolTexts(requests, 3)[2];
  assert.match(doomed, /disk full/);
  const log = toolTexts(requests, 4)[3];
  assert.match(log, /tools\/call\+task,tasks\/get,tasks\/get,tasks\/get,tasks\/result,tools\/call,tools\/call\+task/);
});

test('interrupting a task-backed MCP call sends tasks/cancel', async (t) => {
  const client = new McpServerClient({ name: 'jobs', command: process.execPath, args: ['-e', SERVER] });
  t.after(() => client.close());
  await client.start();
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('user pressed Esc')), 300);
  await assert.rejects(client.callTool('forever', {}, { autoApprove: true, signal: controller.signal }), /Esc|abort/i);
  assert.equal(client.activeTasks.size, 0);
  const log = await client.callTool('log', {}, { autoApprove: true });
  assert.match(JSON.stringify(log.content), /tools\/call\+task,(tasks\/get,)+tasks\/cancel/);
});

test('a long MCP task moves to the background and its result is delivered later', async (t) => {
  const client = new McpServerClient({ name: 'jobs', command: process.execPath, args: ['-e', SERVER] });
  t.after(() => client.close());
  await client.start();
  let background = null;
  const controller = new AbortController();
  const result = await client.callTool('slow', {}, { autoApprove: true, signal: controller.signal, env: { OASIS_MCP_TASK_BACKGROUND_MS: '20' }, onBackgroundTask: (task) => { background = task; } });
  assert.match(JSON.stringify(result.content), /moved to the background/);
  assert.equal(background.server, 'jobs');
  assert.equal(background.tool, 'slow');
  // Ending the turn after the move does not cancel the task.
  controller.abort(new Error('turn ended'));
  const settled = await background.settled;
  assert.equal(settled.isError, false);
  assert.match(JSON.stringify(settled.content), /slow-result after 3 polls/);
});

test('without a background sink, or with the opt-out, the call waits for the task', async (t) => {
  assert.equal(mcpTaskBackgroundMs({}), 5000);
  assert.equal(mcpTaskBackgroundMs({ OASIS_MCP_TASK_BACKGROUND: '0' }), -1);
  assert.equal(mcpTaskBackgroundMs({ CLAUDE_CODE_DISABLE_MCP_TASK_BACKGROUND: '1' }), -1);
  const client = new McpServerClient({ name: 'jobs', command: process.execPath, args: ['-e', SERVER] });
  t.after(() => client.close());
  await client.start();
  let called = false;
  const waited = await client.callTool('slow', {}, { autoApprove: true, env: { OASIS_MCP_TASK_BACKGROUND: '0' }, onBackgroundTask: () => { called = true; } });
  assert.equal(called, false);
  assert.match(JSON.stringify(waited.content), /slow-result/);
});

test('an interactive session gets the background MCP result in its inbox and is woken', async (t) => {
  const prior = process.env.OASIS_MCP_TASK_BACKGROUND_MS;
  process.env.OASIS_MCP_TASK_BACKGROUND_MS = '20';
  t.after(() => { if (prior === undefined) delete process.env.OASIS_MCP_TASK_BACKGROUND_MS; else process.env.OASIS_MCP_TASK_BACKGROUND_MS = prior; });
  const { session, requests } = await sessionWithServer(t, [toolCall('c1', 'mcp_jobs_slow', {}), { content: 'started it' }]);
  const woke = new Promise((resolve) => { session.onBackgroundEvent = resolve; });
  await runAgentTurn(session, 'run the slow job', { autoApprove: true });
  assert.match(toolTexts(requests, 1)[0], /moved to the background/);
  const event = await woke;
  assert.equal(event.kind, 'mcp-task');
  const notice = session.inbox.find((entry) => entry.kind === 'mcp-task');
  assert.match(notice.text, /Background MCP task task-\d+ \(jobs slow\) finished/);
  assert.match(notice.text, /slow-result after 3 polls/);
});

test('/tasks lists MCP tasks running in the background', async () => {
  const { runBuiltinCommand } = await import('../src/slash.mjs');
  const session = { root: '/tmp', messages: [], mcpBackgroundTasks: new Map([['task-9', { server: 'jobs', tool: 'slow', startedAt: Date.now() - 4000 }]]) };
  const { output } = await runBuiltinCommand('tasks', '', { root: '/tmp', session, env: {} });
  assert.match(output, /MCP tasks/);
  assert.match(output, /task-9 {2}running {2}jobs slow {2}\(4s\)/);
});

test('/tasks groups finished agents under Earlier in this session and can message them', async () => {
  const { runBuiltinCommand } = await import('../src/slash.mjs');
  const inbox = [];
  const now = Date.now();
  const agents = new Map([
    ['agent_1', { id: 'agent_1', type: 'explore', description: 'map the repo', status: 'running', background: true, startedAt: now - 3000, finishedAt: null, toolCalls: 2, recentTools: ['grep'], child: { inbox } }],
    ['agent_2', { id: 'agent_2', type: 'general', description: 'fix the parser', status: 'completed', background: true, startedAt: now - 9000, finishedAt: now - 1000, toolCalls: 7, recentTools: [], child: null, restoredTranscript: true }],
    ['agent_3', { id: 'agent_3', type: 'general', description: 'old job', status: 'completed', background: false, startedAt: now - 9000, finishedAt: now - 5000, toolCalls: 1, recentTools: [], child: null }]
  ]);
  const session = { root: '/tmp', messages: [], agentTasks: { next: 4, agents, teams: new Map(), events: [], nextEventId: 1 } };
  const state = { root: '/tmp', session, env: {} };
  const { output } = await runBuiltinCommand('tasks', '', state);
  assert.match(output, /Agents:\n {2}agent_1 +running/);
  assert.match(output, /Earlier in this session:\n {2}agent_2 +completed[^\n]*\n {2}agent_3/);
  assert.match(output, /\/tasks send ID MESSAGE/);
  const queued = await runBuiltinCommand('tasks', 'send agent_1 also check the tests', state);
  assert.match(queued.output, /Queued for agent_1/);
  assert.equal(inbox[0].text, 'New message from the user:\nalso check the tests');
  const resumed = await runBuiltinCommand('tasks', 'send agent_2 handle "quotes" too', state);
  assert.match(resumed.prompt, /send_message with id "agent_2"/);
  assert.match(resumed.prompt, /"handle \\"quotes\\" too"/);
  const blocked = await runBuiltinCommand('tasks', 'send agent_3 hi', state);
  assert.match(blocked.output, /cannot be resumed/);
});
