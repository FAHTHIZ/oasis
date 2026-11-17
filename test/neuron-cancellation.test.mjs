// Roadmap 1.4: cancelling any neuron stops all of its descendants within two
// seconds, even while they sit in a long tool call, and an ended neuron gives
// up its shared-task leases at once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { agentRegistry, stopAgent } from '../src/agent-tasks.mjs';
import { createSharedTaskStore, runSharedTaskTool, releaseAgentLeases } from '../src/shared-tasks.mjs';

// A long tool call that is not a bare `sleep` (the agent refuses those).
const SLEEP_MS = 47123;

function sleepersLeft(marker) {
  try { return execFileSync('pgrep', ['-f', 'sleeper-' + marker], { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch { return 0; }
}

async function fixture(t, { leadBackground = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-cancel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.oasis', 'agents'), { recursive: true });
  await writeFile(path.join(root, '.oasis', 'agents', 'lead.md'), '---\nname: lead\ndescription: Delegates\n---\nYou are the LEAD.\n');
  await writeFile(path.join(root, 'sleeper-' + SLEEP_MS + '.js'), 'setTimeout(() => {}, ' + SLEEP_MS + ');\n');
  await writeFile(path.join(root, '.oasis', 'agents', 'worker.md'), '---\nname: worker\ndescription: Works\n---\nYou are the WORKER.\n');
  let workerSleeping;
  const sleeping = new Promise((resolve) => { workerSleeping = resolve; });
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    const system = String(payload.messages[0].content);
    const hasTool = payload.messages.some((m) => m.role === 'tool');
    const call = (name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'c' + Math.random().toString(36).slice(2), type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    let message;
    if (/You are the WORKER/.test(system)) {
      if (!hasTool) {
        message = call('task_claim', {});
      } else if (payload.messages.filter((m) => m.role === 'tool').length === 1) {
        message = call('run_command', { command: process.execPath, args: ['sleeper-' + SLEEP_MS + '.js'] });
        setTimeout(workerSleeping, 400);
      } else message = { role: 'assistant', content: 'worker done' };
    } else if (/You are the LEAD/.test(system)) {
      message = hasTool ? { role: 'assistant', content: 'lead done' } : call('task', { description: 'work', prompt: 'do the work', subagent_type: 'worker' });
    } else {
      message = hasTool ? { role: 'assistant', content: 'main done' } : call('task', { description: 'lead', prompt: 'lead the work', subagent_type: 'lead', ...(leadBackground ? { run_in_background: true } : {}) });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_NEURON_LEDGER: '0', OASIS_SANDBOX: 'off' };
  const session = await createSession({ root, env, settings: { permissions: { allow: ['run_command(' + process.execPath + ' sleeper-' + SLEEP_MS + '.js)'], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } }, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 8 } });
  session.sharedTasks = createSharedTaskStore();
  runSharedTaskTool(session, 'task_create', { subject: 'the work' });
  return { session, env, sleeping };
}

test('cancelling the main turn stops a nested tree in a long tool call within 2 s and frees its lease', async (t) => {
  const { session, env, sleeping } = await fixture(t);
  const controller = new AbortController();
  const turn = runAgentTurn(session, 'go', { autoApprove: true, env, signal: controller.signal }).then(() => null, (error) => error);
  await sleeping;
  const records = [...agentRegistry(session).agents.values()];
  assert.equal(records.length, 2, 'lead and worker started');
  assert.equal(session.sharedTasks.tasks[0].claimedBy !== '', true, 'the worker holds a lease');
  const started = Date.now();
  controller.abort();
  const error = await turn;
  const elapsed = Date.now() - started;
  assert.ok(error, 'the turn was cancelled');
  assert.ok(elapsed < 2000, 'stopped in ' + elapsed + ' ms');
  for (const record of records) assert.notEqual(record.status, 'running', record.description + ' is ' + record.status);
  assert.equal(session.sharedTasks.tasks[0].claimedBy, '', 'the lease was released');
  assert.equal(session.sharedTasks.tasks[0].status, 'pending');
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sleepersLeft(SLEEP_MS), 0, 'no sleep process outlived the cancel');
});

test('agent_stop on a background lead stops its nested worker within 2 s', async (t) => {
  const { session, env, sleeping } = await fixture(t, { leadBackground: true });
  await runAgentTurn(session, 'go', { autoApprove: true, env });
  await sleeping;
  const registry = agentRegistry(session);
  const lead = [...registry.agents.values()].find((record) => record.type === 'lead');
  const worker = [...registry.agents.values()].find((record) => record.type === 'worker');
  assert.ok(lead && worker, 'both started');
  const started = Date.now();
  stopAgent(session, { id: lead.id });
  while ((lead.status === 'running' || worker.status === 'running') && Date.now() - started < 5000) await new Promise((resolve) => setTimeout(resolve, 20));
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 2000, 'stopped in ' + elapsed + ' ms (lead ' + lead.status + ', worker ' + worker.status + ')');
  assert.equal(session.sharedTasks.tasks[0].claimedBy, '', 'the lease was released');
  await lead.promise.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(sleepersLeft(SLEEP_MS), 0, 'no sleep process outlived the stop');
});

test('releaseAgentLeases frees only that agent\'s active claims', () => {
  const session = { sharedTasks: createSharedTaskStore() };
  runSharedTaskTool(session, 'task_create', { subject: 'a' });
  runSharedTaskTool(session, 'task_create', { subject: 'b' });
  runSharedTaskTool({ ...session, agentId: 'agent-1', sharedTasks: session.sharedTasks }, 'task_claim', { task_id: 'task_1' });
  runSharedTaskTool({ ...session, agentId: 'agent-2', sharedTasks: session.sharedTasks }, 'task_claim', { task_id: 'task_2' });
  assert.deepEqual(releaseAgentLeases(session, 'agent-1'), ['task_1']);
  assert.equal(session.sharedTasks.tasks[0].claimedBy, '');
  assert.equal(session.sharedTasks.tasks[0].status, 'pending');
  assert.equal(session.sharedTasks.tasks[1].claimedBy, 'agent-2');
  assert.deepEqual(releaseAgentLeases(session, 'main'), []);
});
