import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { createSession, closeSession, runAgentTurn } from '../src/agent.mjs';
import { setWorkspaceTrust } from '../src/settings.mjs';
import { useMcpTask } from '../src/mcp-project.mjs';
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
