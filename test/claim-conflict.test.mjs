import assert from 'node:assert/strict';
import test from 'node:test';
import { claimConflict, claimNumbers, topicSimilarity } from '../src/claim-conflict.mjs';
import { createEvidenceLedger, recordEvidence } from '../src/evidence-ledger.mjs';
import { contestsOf, createKnowledgeBoard, knowledgePromptSection, openConflicts, runKnowledgeTool, sanitizeKnowledgeBoard } from '../src/knowledge-board.mjs';

test('figures are normalized: separators, k/million, percent, versions; years kept apart', () => {
  const { values, years } = claimNumbers('In 2025 it served 1,200 users, 1.5k sessions, 3 million requests, 40% hit rate on v2.1.0.');
  assert.deepEqual([...values].sort(), ['1200', '1500', '3000000', '40%', 'v2.1.0'].sort());
  assert.deepEqual([...years], ['2025']);
  assert.deepEqual([...claimNumbers('It takes 5 more minutes').values], ['5'], '"5 more" is not 5 million');
});

test('conflicts: different figures, negation and opposite words on the same subject', () => {
  assert.equal(claimConflict('The API allows 500 requests per minute.', 'The API allows 1000 requests per minute.').reason, '500 vs 1000');
  assert.equal(claimConflict('Node 22.1.0 added require(esm).', 'Node 20.3.0 added require(esm).').kind, 'numbers');
  assert.equal(claimConflict('The library supports streaming responses.', 'The library does not support streaming responses.').kind, 'negation');
  assert.equal(claimConflict('Revenue increased in the third quarter.', 'Revenue decreased in the third quarter.').reason, '"increased" vs "decreased"');
});

test('no conflict: same facts, rewordings, different years, different subjects', () => {
  assert.equal(claimConflict('The API allows 1,000 requests per minute.', 'The API allows 1k requests per minute.'), null);
  assert.equal(claimConflict('Revenue was 4.1 billion in 2024.', 'Revenue was 4.6 billion in 2025.'), null, 'a change over time is not a dispute');
  assert.equal(claimConflict('Session files are saved by saveSession in src/sessions.mjs.', 'Session files are written by saveSession in src/sessions.mjs.'), null);
  assert.equal(claimConflict('The API allows 500 requests per minute.', 'The database stores 1000 rows per page.'), null);
  assert.ok(topicSimilarity('The API allows 500 requests per minute.', 'The API allows 1000 requests per minute.') === 1);
});

function poster(id, board, urls = []) {
  const ledger = createEvidenceLedger();
  for (const url of urls) recordEvidence(ledger, { kind: 'fetch', tool: 'fetch_url', url, numbers: ['500', '1000'] });
  return { agentId: id, agentType: 'Explore', evidenceLedger: ledger, knowledgeBoard: board };
}

test('a contradicting post is kept as a contest instead of counting as corroboration', () => {
  const board = createKnowledgeBoard();
  const first = runKnowledgeTool(poster('agent_1', board, ['https://a.com/limits']), 'knowledge_post', { claim: 'The API allows 500 requests per minute.', sources: ['https://a.com/limits'] });
  assert.equal(first.posted, 'k_1');
  const second = runKnowledgeTool(poster('agent_2', board, ['https://b.com/limits']), 'knowledge_post', { claim: 'The API allows 1000 requests per minute.', sources: ['https://b.com/limits'] });
  assert.equal(second.corroborated, undefined, 'a different figure is not corroboration');
  assert.equal(second.posted, 'k_2');
  assert.equal(second.contested, true);
  assert.match(second.note, /disagrees with k_1 by agent_1 \(grounded: 500 vs 1000\)/);
  assert.equal(second.finding.contested_by[0].id, 'k_1');
  assert.equal(second.finding.contested_by[0].detected, true);
  assert.equal(board.entries[0].corroboratedBy.length, 0);

  const contested = runKnowledgeTool({ agentId: '', knowledgeBoard: board }, 'knowledge_search', { status: 'contested' });
  assert.deepEqual(contested.findings.map((item) => item.id).sort(), ['k_1', 'k_2']);
  assert.equal(contested.open_disputes, 1);
  assert.match(knowledgePromptSection({ knowledgeBoard: board }, 'API requests per minute'), /k_1 \[grounded, agent_1, CONTESTED by k_2\]/);
  assert.deepEqual(openConflicts(board, { author: 'agent_2' })[0].findings, ['k_1', 'k_2']);
  assert.deepEqual(openConflicts(board, { author: 'agent_9' }), []);

  // An agreeing post still corroborates the side it agrees with.
  const third = runKnowledgeTool(poster('agent_3', board, ['https://a.com/limits']), 'knowledge_post', { claim: 'The API allows 500 requests per minute.', sources: ['https://a.com/limits'] });
  assert.equal(third.corroborated, 'k_1');

  // Retracting one side resolves the dispute.
  const retract = runKnowledgeTool({ agentId: '', knowledgeBoard: board }, 'knowledge_post', { retract: 'k_2', reason: 'b.com shows the burst limit, not the sustained one' });
  assert.deepEqual(retract.resolved, ['k_1']);
  assert.equal(contestsOf(board, board.entries[0]).length, 0);
  assert.deepEqual(openConflicts(board), []);
});

test('explicit contradicts and supports links, validated, saved and restored', () => {
  const board = createKnowledgeBoard();
  runKnowledgeTool(poster('agent_1', board), 'knowledge_post', { claim: 'The retry loop lives in src/providers.mjs.' });
  const disagree = runKnowledgeTool(poster('agent_2', board), 'knowledge_post', { claim: 'Retries are handled by the HTTP client wrapper in src/http.mjs.', contradicts: ['k_1'] });
  assert.equal(disagree.contested, true);
  assert.equal(disagree.finding.contested_by[0].detected, undefined);
  const backs = runKnowledgeTool(poster('agent_3', board), 'knowledge_post', { claim: 'src/http.mjs wraps fetch with exponential backoff.', supports: ['k_2'] });
  assert.deepEqual(backs.finding.supports, ['k_2']);
  const search = runKnowledgeTool({ agentId: '', knowledgeBoard: board }, 'knowledge_search', { query: 'retries http client' });
  assert.deepEqual(search.findings.find((item) => item.id === 'k_2').supported_by, ['k_3']);
  assert.throws(() => runKnowledgeTool(poster('agent_4', board), 'knowledge_post', { claim: 'x is y', contradicts: ['k_99'] }), /Unknown finding k_99/);

  const restored = sanitizeKnowledgeBoard(JSON.parse(JSON.stringify(board)));
  assert.deepEqual(openConflicts(restored).map((item) => item.findings), [['k_1', 'k_2']]);
  assert.deepEqual(sanitizeKnowledgeBoard({ entries: [{ id: 'k_1', claim: 'c', relations: [{ type: 'hates', target: 'k_2' }, { type: 'supports', target: 'nope' }] }] }).entries[0].relations, []);
});

test('an author refining its own finding is not a dispute', () => {
  const board = createKnowledgeBoard();
  const me = poster('agent_1', board, ['https://a.com/limits']);
  runKnowledgeTool(me, 'knowledge_post', { claim: 'The API allows 500 requests per minute.', sources: ['https://a.com/limits'] });
  const again = runKnowledgeTool(me, 'knowledge_post', { claim: 'The API allows 1000 requests per minute.', sources: ['https://a.com/limits'] });
  assert.equal(again.contested, undefined);
});
