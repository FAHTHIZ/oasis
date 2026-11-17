import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile } from 'node:fs/promises';
import { scriptedModel } from './helpers/scripted-model.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { saveSession, loadSession } from '../src/sessions.mjs';
import { runBuiltinCommand } from '../src/slash.mjs';
import { agentEvents } from '../src/agent-tasks.mjs';
import { answerApproval, approvalSnapshot, callDigest, consumeGrant, parkApproval, restoreApprovals } from '../src/neuron-approvals.mjs';

const call = (id, name, args) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } });
const isChild = (payload) => String(payload.messages[0] && payload.messages[0].content || '').includes('SUBAGENT MODE');
const lastUser = (payload) => [...payload.messages].reverse().find((m) => m.role === 'user')?.content || '';
const RUN = { command: 'node -e "require(\'fs\').appendFileSync(\'count.txt\', \'x\')"' };

let childCalls = 0;
function router(payload) {
  if (isChild(payload)) {
    const messages = payload.messages;
    const approvedAt = messages.findIndex((m) => m.role === 'user' && /The user approved your waiting request/.test(String(m.content)));
    if (approvedAt >= 0) {
      const toolsAfter = messages.slice(approvedAt).filter((m) => m.role === 'tool').length;
      // The approved call, then the same call again: only the first may run.
      if (toolsAfter < 2) return { content: null, tool_calls: [call('w' + (++childCalls), 'run_command', RUN)] };
      return { content: 'Wrote out.txt once; the repeat is waiting again.' };
    }
    if (!messages.some((m) => m.role === 'tool')) return { content: null, tool_calls: [call('w' + (++childCalls), 'run_command', RUN)] };
    return { content: 'The write to out.txt is waiting for the user\'s approval.' };
  }
  const lastUserIndex = payload.messages.map((m) => m.role).lastIndexOf('user');
  const hasTool = payload.messages.slice(lastUserIndex).some((m) => m.role === 'tool');
  const user = lastUser(payload);
  if (/start the worker/.test(user) && !hasTool) return { content: null, tool_calls: [call('t1', 'task', { subagent_type: 'general-purpose', description: 'write a file', prompt: 'Write out.txt.', run_in_background: true })] };
  const send = /Call send_message with id "agent_1" and exactly this message[\s\S]*Message: (".*")/.exec(user);
  if (send && !hasTool) return { content: null, tool_calls: [call('s1', 'send_message', { id: 'agent_1', message: JSON.parse(send[1]) })] };
  return { content: 'ok' };
}

test('a background approval survives a restart, and approving runs the tool exactly once', async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-apv-home-'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-apv-root-'));
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  childCalls = 0;
  const { config } = await scriptedModel(t, Array.from({ length: 30 }, () => router));

  const first = await createSession({ root, config, permissionMode: 'default', env });
  await runAgentTurn(first, 'start the worker', { env });
  const record = first.agentTasks.agents.get('agent_1');
  await record.promise;
  assert.equal(record.status, 'completed', record.error || '');
  assert.equal(record.pendingApprovals.length, 1);
  assert.equal(record.pendingApprovals[0].tool, 'run_command');
  await assert.rejects(readFile(path.join(root, 'count.txt')), /ENOENT/);
  assert.ok(agentEvents(first).events.some((event) => event.type === 'agent.approval_pending'));
  assert.match((await runBuiltinCommand('tasks', '', { root, session: first, env })).output, /waiting for approval: run_command/);
  const saved = await saveSession(first, { env });

  // A new process: the request is still there and can be answered.
  const restored = await loadSession(root, saved.id, { env });
  const second = await createSession({ root, config, restore: restored, permissionMode: 'default', env });
  const again = second.agentTasks.agents.get('agent_1');
  assert.equal(again.pendingApprovals.length, 1);
  const answer = await runBuiltinCommand('tasks', 'approve agent_1', { root, session: second, env });
  assert.ok(answer.prompt, answer.output);
  assert.equal(again.pendingApprovals.length, 0);
  await runAgentTurn(second, answer.prompt, { env });
  await again.promise;
  assert.equal(again.status, 'completed', again.error || '');
  assert.equal(await readFile(path.join(root, 'count.txt'), 'utf8'), 'x', 'the approved command ran exactly once');
  assert.equal(childCalls, 3, 'first try, approved call, repeat');
  // The repeat was not covered by the one-time grant; it waits again.
  assert.equal(again.pendingApprovals.length, 1);
  assert.equal((again.approvalGrants || []).length, 0);
  assert.ok(agentEvents(second).events.some((event) => event.type === 'agent.approval_used'));
});

test('grants match one exact call and are used up', () => {
  const record = { id: 'agent_1' };
  parkApproval(record, { tool: 'run_command', input: { command: 'npm test' } });
  parkApproval(record, { tool: 'run_command', input: { command: 'npm test' } });
  assert.equal(record.pendingApprovals.length, 1, 'the same call is parked once');
  parkApproval(record, { tool: 'write_file', input: { path: 'a', content: 'b' } });
  assert.throws(() => answerApproval(record, { allow: true }), /2 requests waiting/);
  const id = record.pendingApprovals[0].id;
  const { message } = answerApproval(record, { allow: true, approvalId: id });
  assert.match(message, /approved/);
  assert.equal(consumeGrant(record, 'run_command', { command: 'npm test --force' }), false);
  assert.equal(consumeGrant(record, 'run_command', { command: 'npm test' }), true);
  assert.equal(consumeGrant(record, 'run_command', { command: 'npm test' }), false);
  const denied = answerApproval(record, { allow: false });
  assert.match(denied.message, /denied/);
  assert.equal((record.approvalGrants || []).length, 0);
  assert.throws(() => answerApproval(record, { allow: true }), /no request/);
  assert.equal(callDigest('t', { a: 1, b: 2 }), callDigest('t', { b: 2, a: 1 }));
});

test('saved approval state drops malformed entries', () => {
  const restored = restoreApprovals({
    pendingApprovals: [{ id: 'approval_0123abcd', tool: 'write_file', digest: 'a'.repeat(32), input: '{}' }, { id: '../evil', digest: 'b'.repeat(32) }, null],
    approvalGrants: ['c'.repeat(32), 'nope']
  });
  assert.deepEqual(restored.pendingApprovals.map((item) => item.id), ['approval_0123abcd']);
  assert.deepEqual(restored.approvalGrants, ['c'.repeat(32)]);
  assert.deepEqual(approvalSnapshot({}), {});
});
