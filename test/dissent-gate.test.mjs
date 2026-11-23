import test from 'node:test';
import assert from 'node:assert/strict';
import { unacknowledgedDissent, dissentNudge, dissentGateEnabled } from '../src/dissent-gate.mjs';
import { runKnowledgeTool, sanitizeKnowledgeBoard } from '../src/knowledge-board.mjs';
import { runHypothesisTool } from '../src/hypothesis-board.mjs';

function disputedBoard() {
  const board = sanitizeKnowledgeBoard({ entries: [
    { id: 'k_1', claim: 'The Acme API rate limit is 500 requests per minute.', author: 'agent_1', status: 'noted', at: '2026-01-01T00:00:00Z' },
    { id: 'k_2', claim: 'The Acme API rate limit is 1000 requests per minute.', author: 'agent_2', status: 'noted', at: '2026-01-01T00:00:00Z', relations: [{ type: 'contradicts', target: 'k_1' }] }
  ] });
  return board;
}

test('a reply that states one side of an open dispute is caught', () => {
  const board = disputedBoard();
  const items = unacknowledgedDissent(board, 'The Acme API allows 1000 requests per minute, so batching is unnecessary.');
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'k_2');
  assert.equal(items[0].against, 'k_1');
  assert.match(dissentNudge(items), /disputed by k_1 from agent_1 \("The Acme API rate limit is 500/);
});

test('acknowledging the dispute, mentioning both sides or another subject passes', () => {
  const board = disputedBoard();
  assert.deepEqual(unacknowledgedDissent(board, 'Sources disagree on the Acme API rate limit: 500 or 1000 requests per minute.'), []);
  assert.deepEqual(unacknowledgedDissent(board, 'The Acme API rate limit is probably 1000 requests per minute.'), []);
  assert.deepEqual(unacknowledgedDissent(board, 'The Acme API limit is 500 or 1000 per minute, depending on plan.'), []);
  assert.deepEqual(unacknowledgedDissent(board, 'I fixed the 1000 failing snapshots.'), []);
  // Retracting a side settles it.
  runKnowledgeTool({ knowledgeBoard: board, agentId: 'main' }, 'knowledge_post', { retract: 'k_1', reason: 'old docs' });
  assert.deepEqual(unacknowledgedDissent(board, 'The Acme API allows 1000 requests per minute.'), []);
});

test('stating the top hypothesis of an unsettled question is caught; a settled one is not', () => {
  const board = sanitizeKnowledgeBoard({});
  runHypothesisTool({}, board, { action: 'open', question: 'Why does the login test fail on CI?', hypotheses: ['A race in session setup', 'A timezone difference on the runner'] }, { actor: 'main' });
  runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'Fails with TZ=UTC locally', ratings: { h_1: '+', h_2: '-' } }, { actor: 'agent_1', ground: () => ({ issues: [], grounds: ['ran'] }) });
  const items = unacknowledgedDissent(board, 'The login test fails on CI because of a race in session setup.');
  assert.equal(items.length, 1);
  assert.equal(items[0].kind, 'question');
  assert.match(dissentNudge(items), /has not settled it/);
  runHypothesisTool({}, board, { action: 'resolve', question: 'q_1', hypothesis: 'h_1' }, { actor: 'main' });
  assert.deepEqual(unacknowledgedDissent(board, 'The login test fails on CI because of a race in session setup.'), []);
});

test('the gate runs once per turn in the completion gates and can be turned off', async () => {
  assert.equal(dissentGateEnabled({ OASIS_DISSENT_GATE: '0' }), false);
  assert.equal(dissentGateEnabled({}), true);
  const { runCompletionGates, newGateState } = await import('../src/completion-gates.mjs');
  const session = { knowledgeBoard: disputedBoard(), messages: [], hookMessages: [], root: process.cwd() };
  const turn = () => ({ session, options: { env: {} }, request: {}, text: 'The Acme API allows 1000 requests per minute.', assistant: {}, assistantMessage: {}, verification: { changedPaths: new Set(), ranPaths: new Set() }, claimState: {}, totals: { toolCalls: 0, tokensUsed: 0 }, gates });
  const host = { emitDisplayText: async () => {}, pruneHistory: () => {}, recordSessionEvent: () => {}, hookOptions: () => ({}), availableToolNames: () => new Set() };
  const gates = newGateState();
  const first = await runCompletionGates(turn(), host);
  assert.deepEqual(first, { type: 'continue' });
  assert.match(session.messages.at(-1).content, /takes one side/);
  const before = session.messages.length;
  const second = await runCompletionGates(turn(), host);
  assert.notDeepEqual(second, { type: 'continue' });
  assert.equal(session.messages.length, before);
});
