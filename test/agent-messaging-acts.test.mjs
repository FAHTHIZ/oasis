import test from 'node:test';
import assert from 'node:assert/strict';
import { agentRegistry, registerAgent, sendTeamMessage, drainInbox, agentTeamStatus, createAgentTeam, lapseAgentDialogue, AGENT_TOOL_DEFINITIONS } from '../src/agent-tasks.mjs';
import { recordDialogue, openObligations, openThreads, SPEECH_ACTS } from '../src/agent-dialogue.mjs';

import { createSharedTaskStore } from '../src/shared-tasks.mjs';

function team() {
  const main = { sharedTasks: createSharedTaskStore() };
  const registry = agentRegistry(main);
  const a = registerAgent(main, { type: 'general-purpose', description: 'API designer', child: { inbox: [] } });
  const b = registerAgent(main, { type: 'general-purpose', description: 'test writer', child: { inbox: [] } });
  return { main, registry, a, b, as: (agent) => ({ agentTasks: registry, agentId: agent.id, sharedTasks: main.sharedTasks }) };
}

test('team_send_message advertises the speech acts', () => {
  const tool = AGENT_TOOL_DEFINITIONS.find((item) => item.function.name === 'team_send_message');
  assert.deepEqual(tool.function.parameters.properties.act.enum, SPEECH_ACTS);
  assert.ok(tool.function.parameters.properties.reply_to);
  assert.deepEqual(tool.function.parameters.required, ['to', 'message']);
});

test('a plain message is an inform with an id and creates no obligation', () => {
  const { a, b, as, registry } = team();
  const sent = sendTeamMessage(as(a), { to: b.id, message: 'FYI the schema is in api.md' });
  assert.equal(sent.act, 'inform');
  assert.equal(sent.id, 'm_1');
  assert.match(drainInbox(b.child), /\[inform m_1\]\nDirect message from teammate agent_1/);
  assert.deepEqual(openObligations(registry, b.id).owes, []);
});

test('a request obliges the recipient until it answers with reply_to', () => {
  const { a, b, as, registry } = team();
  const sent = sendTeamMessage(as(a), { to: b.id, message: 'Which status code for a missing user?', act: 'request', about: 'task_2' });
  assert.match(sent.message, /agent_2 owes a reply to m_1/);
  const text = drainInbox(b.child);
  assert.match(text, /\[request m_1, about task_2\] agent_1 expects a reply/);
  assert.match(text, /reply_to "m_1"/);
  assert.equal(openObligations(registry, b.id).owes[0].id, 'm_1');
  assert.equal(openObligations(registry, a.id).awaiting[0].id, 'm_1');
  const reply = sendTeamMessage(as(b), { to: a.id, message: '404 with an error envelope', act: 'answer', reply_to: 'm_1' });
  assert.equal(reply.closes, 'm_1');
  assert.match(drainInbox(a.child), /\[answer m_2, replying to m_1\]/);
  assert.deepEqual(openObligations(registry, b.id).owes, []);
  assert.equal(registry.dialogue.messages[0].outcome, 'answered');
});

test('replies need reply_to, must be on your own thread, and accept/reject only answer open questions', () => {
  const { main, a, b, as } = team();
  const c = registerAgent(main, { type: 'general-purpose', description: 'outsider', child: { inbox: [] } });
  assert.throws(() => sendTeamMessage(as(b), { to: a.id, message: 'yes', act: 'answer' }), /reply_to/);
  assert.throws(() => sendTeamMessage(as(b), { to: a.id, message: 'yes', act: 'answer', reply_to: 'm_9' }), /No message m_9/);
  assert.throws(() => sendTeamMessage(as(b), { to: a.id, message: 'x', act: 'shout' }), /act must be one of/);
  sendTeamMessage(as(a), { to: b.id, message: 'Rename the field?', act: 'propose' });
  assert.throws(() => sendTeamMessage(as(c), { to: a.id, message: 'sure', act: 'accept', reply_to: 'm_1' }), /your own threads/);
  sendTeamMessage(as(a), { to: b.id, message: 'note', act: 'inform' });
  assert.throws(() => sendTeamMessage(as(b), { to: a.id, message: 'ok', act: 'accept', reply_to: 'm_2' }), /request, proposal or challenge/);
  const accepted = sendTeamMessage(as(b), { to: a.id, message: 'Agreed', act: 'accept', reply_to: 'm_1' });
  assert.equal(accepted.closes, 'm_1');
});

test('the asker replying on its own request does not discharge it', () => {
  const { a, b, as, registry } = team();
  sendTeamMessage(as(a), { to: b.id, message: 'Need the port number', act: 'request' });
  const nudge = sendTeamMessage(as(a), { to: b.id, message: 'Still need it', act: 'inform', reply_to: 'm_1' });
  assert.equal(nudge.closes, undefined);
  assert.equal(openObligations(registry, b.id).owes.length, 1);
});

test('a commit obliges the sender until it delivers', () => {
  const { a, b, as, registry } = team();
  const sent = sendTeamMessage(as(a), { to: b.id, message: 'I will write the migration', act: 'commit' });
  assert.match(sent.message, /You now owe delivery/);
  assert.match(drainInbox(b.child), /has committed to this/);
  assert.equal(openObligations(registry, a.id).owes[0].act, 'commit');
  const later = sendTeamMessage(as(a), { to: b.id, message: 'Unrelated', act: 'request' });
  assert.deepEqual(later.you_still_owe, ['m_1 (commit from agent_1)']);
  const done = sendTeamMessage(as(a), { to: b.id, message: 'Migration is in db/002.sql', act: 'inform', reply_to: 'm_1' });
  assert.equal(done.closes, 'm_1');
  assert.equal(registry.dialogue.messages[0].outcome, 'delivered');
});

test('team_status lists open threads for the team', () => {
  const main = {};
  const registry = agentRegistry(main);
  const created = createAgentTeam(main, { name: 'api' });
  const a = registerAgent(main, { type: 'general-purpose', description: 'one', teamId: created.team.id, child: { inbox: [] } });
  const b = registerAgent(main, { type: 'general-purpose', description: 'two', teamId: created.team.id, child: { inbox: [] } });
  sendTeamMessage({ agentTasks: registry, agentId: a.id }, { to: b.id, message: 'Your finding k_3 contradicts the docs', act: 'challenge', about: 'k_3' });
  const status = agentTeamStatus(main, { team_id: created.team.id });
  assert.equal(status.team.open_threads.length, 1);
  assert.equal(status.team.open_threads[0].owed_by, b.id);
  assert.equal(status.team.open_threads[0].about, 'k_3');
  assert.equal(agentTeamStatus(main, {}).open_threads.length, 1);
});

test('an agent that finishes owing replies lapses them and the waiting agent is told', () => {
  const { main, a, b, as, registry } = team();
  sendTeamMessage(as(a), { to: b.id, message: 'Which auth header?', act: 'request' });
  sendTeamMessage(as(b), { to: a.id, message: 'I will add the fixtures', act: 'commit' });
  drainInbox(a.child); drainInbox(b.child);
  b.status = 'completed';
  const lapsed = lapseAgentDialogue(main, b);
  assert.deepEqual(lapsed.map((item) => item.id).sort(), ['m_1', 'm_2']);
  const notice = drainInbox(a.child);
  assert.match(notice, /Thread m_1 lapsed: agent_2 finished without replying to your request m_1/);
  assert.match(notice, /Thread m_2 lapsed: agent_2 finished without delivering/);
  assert.deepEqual(openThreads(registry), []);
  assert.equal(registry.dialogue.messages[0].outcome, 'lapsed');
});

test('the ledger stays bounded and keeps open threads over closed ones', () => {
  const registry = {};
  recordDialogue(registry, { from: 'agent_1', to: 'agent_2', act: 'request', text: 'keep me' });
  for (let index = 0; index < 600; index++) recordDialogue(registry, { from: 'agent_1', to: 'agent_2', text: 'note ' + index });
  assert.equal(registry.dialogue.messages.length, 500);
  assert.equal(registry.dialogue.messages[0].text, 'keep me');
});

test('a commit goes on the task board, delivery completes it, and a lapse reopens it for anyone', async () => {
  const { runSharedTaskTool } = await import('../src/shared-tasks.mjs');
  const { main, a, b, as } = team();
  const sent = sendTeamMessage(as(a), { to: b.id, message: 'I will write the users migration', act: 'commit' });
  assert.equal(sent.task, 'task_1');
  assert.match(sent.message, /on the task board as task_1, claimed by you/);
  let task = runSharedTaskTool(main, 'task_get', { task_id: 'task_1' }).task;
  assert.equal(task.status, 'in_progress');
  assert.equal(task.claimed_by, a.id);
  assert.match(task.subject, /^Promised to agent_2: I will write the users migration/);
  assert.equal(task.promised, 'agent_2 in m_1');
  const done = sendTeamMessage(as(a), { to: b.id, message: 'Migration is in db/0003_users.sql', act: 'inform', reply_to: 'm_1' });
  assert.equal(done.completed_task, 'task_1');
  task = runSharedTaskTool(main, 'task_get', { task_id: 'task_1' }).task;
  assert.equal(task.status, 'completed');
  assert.equal(task.promised, 'agent_2 in m_1, delivered in m_2');

  sendTeamMessage(as(a), { to: b.id, message: 'I will add the index too', act: 'commit' });
  const lapsed = lapseAgentDialogue(main, a);
  assert.equal(lapsed[0].reopened_task, 'task_2');
  task = runSharedTaskTool(main, 'task_get', { task_id: 'task_2' }).task;
  assert.equal(task.status, 'pending');
  assert.equal(task.claimed_by, null);
  assert.equal(task.ready, true);
  assert.match(task.description, /finished without delivering this \(m_3 lapsed\)/);
  assert.match(drainInbox(b.child), /back on the task board as task_2 \(pending\); task_claim it/);
  const claimed = runSharedTaskTool(as(b), 'task_claim', { task_id: 'task_2' });
  assert.equal(claimed.task.claimed_by, b.id);
});

test('promise tasks survive a session save', async () => {
  const { sanitizeSharedTaskStore } = await import('../src/shared-tasks.mjs');
  const { main, a, b, as } = team();
  sendTeamMessage(as(a), { to: b.id, message: 'I will ship the docs', act: 'commit' });
  const restored = sanitizeSharedTaskStore(JSON.parse(JSON.stringify(main.sharedTasks)));
  assert.deepEqual(restored.tasks[0].promise, { message: 'm_1', to: 'agent_2' });
});
