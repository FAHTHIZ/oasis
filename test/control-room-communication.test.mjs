import test from 'node:test';
import assert from 'node:assert/strict';
import { communicationActivity, formatControlRoom } from '../src/control-room.mjs';
import { controlRoomMessages, controlRoomBoards } from '../app/core/control-room.mjs';
import { recordAgentEvent } from '../src/agent-tasks.mjs';
import { runKnowledgeTool } from '../src/knowledge-board.mjs';
import { runSharedTaskTool } from '../src/shared-tasks.mjs';

function session() {
  const s = { agentId: 'main', messages: [] };
  recordAgentEvent(s, 'agent.message_queued', { agentId: 'agent_2', teamId: 'team_1', description: 'agent_1 → agent_2', detail: 'Check   the parser\nfirst' });
  recordAgentEvent(s, 'agent.message_queued', { agentId: 'agent_2', teamId: 'team_1', description: 'agent_1 → agent_2', detail: 'x'.repeat(400) });
  recordAgentEvent(s, 'agent.resume_requested', { agentId: 'agent_3', description: 'review', detail: 'Also cover the tests' });
  recordAgentEvent(s, 'task.dispatched', { agentId: 'agent_4', description: 'not a message' });
  runKnowledgeTool(s, 'knowledge_post', { claim: 'The config loader lives in src/config.mjs' });
  const posted = runKnowledgeTool(s, 'knowledge_post', { claim: 'An abandoned lead' });
  runKnowledgeTool(s, 'knowledge_post', { retract: posted.id || posted.finding?.id || 'k_2', reason: 'wrong' });
  runSharedTaskTool(s, 'task_create', { subject: 'Write the migration' });
  runSharedTaskTool(s, 'task_create', { subject: 'Run the suite', owner: 'agent_2' });
  runSharedTaskTool(s, 'task_claim', { task_id: 'task_2' });
  runSharedTaskTool(s, 'task_checkpoint', { task_id: 'task_2', summary: 'Parser half done' });
  return s;
}

test('communication activity collects messages, knowledge and the task board of live sessions', () => {
  const view = communicationActivity([{ id: 's1', title: 'Refactor', session: session() }, { id: 'empty', session: null }]);
  assert.equal(view.messages.length, 3);
  const team = view.messages.filter((item) => item.from === 'agent_1');
  assert.equal(team.length, 2);
  assert.ok(team.every((item) => item.to === 'agent_2' && item.teamId === 'team_1' && item.sessionId === 's1'));
  assert.ok(team.some((item) => item.preview === 'Check the parser first'));
  assert.ok(team.every((item) => item.preview.length <= 140));
  assert.ok(view.messages.some((item) => item.from === 'main' && item.to === 'agent_3' && item.preview === 'Also cover the tests'));
  assert.deepEqual(view.links.map((link) => [link.from, link.to, link.messages]), [['agent_1', 'agent_2', 2], ['main', 'agent_3', 1]]);
  assert.equal(view.knowledge.findings, 1);
  assert.equal(view.knowledge.retracted, 1);
  assert.match(view.knowledge.recent[0].claim, /config loader/);
  assert.equal(view.tasks.pending, 1);
  assert.equal(view.tasks.in_progress, 1);
  assert.equal(view.tasks.recent[0].status, 'in_progress');
  assert.equal(view.tasks.recent[0].owner, 'main');
  assert.equal(view.tasks.recent[0].claimedBy, 'main');
  assert.equal(view.tasks.recent[0].handoff, 'Parser half done');
});

test('the web app and the terminal render the communication view', () => {
  const now = Date.now();
  const communication = communicationActivity([{ id: 's1', session: session() }], { now });
  const snapshot = { communication };
  const messages = controlRoomMessages(snapshot, { now });
  assert.ok(messages.some((row) => row.title === 'agent_1 → agent_2' && /team team_1/.test(row.meta)));
  const boards = controlRoomBoards(snapshot, { now });
  assert.equal(boards[0].title, 'Knowledge board');
  assert.match(boards[0].detail, /1 finding · 0 grounded · 1 retracted/);
  assert.ok(boards.some((row) => row.title === 'Task board' && /1 in progress · 1 pending · 0 done/.test(row.detail)));
  assert.deepEqual(controlRoomBoards({}, { now }), []);
  const text = formatControlRoom({ updatedAt: new Date(now).toISOString(), summary: { hours: 24, totals: { agents: 0, running: 0, quiet: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, stalled: 0, tokens: 0, requests: 0, costUsd: 0 } }, ledger: { available: true, hours: 24, agents: [], sessions: [], history: [], totals: { agents: 0, running: 0, quiet: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, stalled: 0, tokens: 0, requests: 0, costUsd: 0 } }, resources: { loadAverage: [0, 0, 0], cpus: 1, memoryTotal: 1, memoryFree: 1 }, live: [], communication });
  assert.match(text, /Messages between agents:/);
  assert.match(text, /agent_1 → agent_2: Check the parser first/);
  assert.match(text, /Shared boards: 1 findings/);
});
