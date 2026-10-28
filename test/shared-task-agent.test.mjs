import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

const settings = { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } };
const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });

async function modelServer(t, { parent, child }) {
  const parentRequests = [];
  const childRequests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const payload = JSON.parse(body);
    const isChild = String(payload.messages?.[0]?.content || '').includes('SUBAGENT MODE');
    const list = isChild ? childRequests : parentRequests;
    list.push(payload);
    const last = payload.messages[payload.messages.length - 1];
    const message = await (isChild ? child : parent)(payload, last, list.length);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); }));
  return {
    config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 10, maxCommandSeconds: 10 },
    parentRequests, childRequests
  };
}

test('main session and subagent mutate the same dependency-aware task board', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-shared-task-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, parentRequests, childRequests } = await modelServer(t, {
    parent: (payload, last) => {
      if (last.role === 'user') return { content: null, tool_calls: [call('p1', 'task_create', { subject: 'Verify shared board', description: 'A child agent must be able to see and complete this task.' })] };
      if (last.role === 'tool' && last.name === 'task_create') return { content: null, tool_calls: [call('p2', 'task', { description: 'shared task check', prompt: 'Use task_list to inspect the shared board. Claim task_1 with task_claim, then mark it completed after verifying that it exists.', subagent_type: 'general-purpose' })] };
      if (last.role === 'tool' && last.name === 'task') return { content: 'Shared task coordination verified.' };
      return { content: 'Unexpected parent step.' };
    },
    child: (payload, last) => {
      if (last.role === 'user') return { content: null, tool_calls: [call('c1', 'task_list', {})] };
      if (last.role === 'tool' && last.name === 'task_list') {
        assert.match(last.content, /Verify shared board/);
        return { content: null, tool_calls: [call('c2', 'task_claim', { task_id: 'task_1' })] };
      }
      if (last.role === 'tool' && last.name === 'task_claim') return { content: null, tool_calls: [call('c3', 'task_update', { task_id: 'task_1', status: 'completed' })] };
      if (last.role === 'tool' && last.name === 'task_update') return { content: 'Marked the shared task completed.' };
      return { content: 'Unexpected child step.' };
    }
  });
  const session = await createSession({ root, config, settings });
  t.after(() => closeSession(session));
  const result = await runAgentTurn(session, 'Coordinate this shared task');
  assert.match(result.text, /Shared task coordination verified/);
  assert.equal(session.sharedTasks.tasks.length, 1);
  assert.equal(session.sharedTasks.tasks[0].status, 'completed');
  assert.equal(session.sharedTasks.tasks[0].createdBy, 'main');
  assert.ok(childRequests.some((request) => request.messages.some((message) => message.name === 'task_list')));
  assert.ok(childRequests.some((request) => request.messages.some((message) => message.name === 'task_claim')));
  assert.ok(parentRequests.some((request) => request.messages.some((message) => message.name === 'task')));
});
