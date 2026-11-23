import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSitrep } from '../src/team-sitrep.mjs';
import { agentRegistry, registerAgent, sendTeamMessage, agentTeamStatus, AGENT_TOOL_DEFINITIONS } from '../src/agent-tasks.mjs';
import { createEvidenceLedger, recordEvidence } from '../src/evidence-ledger.mjs';
import { createKnowledgeBoard, runKnowledgeTool } from '../src/knowledge-board.mjs';
import { runHypothesisTool } from '../src/hypothesis-board.mjs';

const grounded = () => ({ issues: [], grounds: ['fetched'] });

function poster(id, board, urls = []) {
  const ledger = createEvidenceLedger();
  for (const url of urls) recordEvidence(ledger, { kind: 'fetch', tool: 'fetch_url', url, numbers: ['500', '1000'] });
  return { agentId: id, agentType: 'Explore', evidenceLedger: ledger, knowledgeBoard: board };
}

test('an empty session has nothing to attend to', () => {
  const sitrep = buildSitrep({ registry: agentRegistry({}), board: createKnowledgeBoard() });
  assert.deepEqual(sitrep.attention, []);
  assert.equal(sitrep.note, 'Nothing needs your attention.');
  assert.match(sitrep.summary, /^0 running, 0 finished, 0 failed; 0 open threads, 0 disputes, 0 open questions\.$/);
});

test('the sitrep ranks a promise the coordinator made and a failed worker above a dispute and a close call', () => {
  const main = { knowledgeBoard: createKnowledgeBoard() };
  const registry = agentRegistry(main);
  const a = registerAgent(main, { type: 'general-purpose', description: 'limits researcher', child: { inbox: [] } });
  const b = registerAgent(main, { type: 'general-purpose', description: 'docs reader', child: { inbox: [] } });
  const c = registerAgent(main, { type: 'general-purpose', description: 'migration writer', child: { inbox: [] } });
  c.status = 'failed'; c.error = 'ENOENT: no such file db/migrate';
  sendTeamMessage(main, { to: a.id, message: 'I will send you the paid-tier list', act: 'commit' });
  const board = main.knowledgeBoard;
  runKnowledgeTool(poster(a.id, board, ['https://a.com/limits']), 'knowledge_post', { claim: 'The API allows 500 requests per minute.', sources: ['https://a.com/limits'] });
  runKnowledgeTool(poster(b.id, board, ['https://b.com/limits']), 'knowledge_post', { claim: 'The API allows 1000 requests per minute.', sources: ['https://b.com/limits'] });
  runHypothesisTool({}, board, { action: 'open', question: 'Why do the limits differ?', hypotheses: ['Docs are stale', 'Limits differ by tier'] }, { actor: 'main', ground: grounded });

  const sitrep = buildSitrep({ registry, board });
  const kinds = sitrep.attention.map((item) => item.kind);
  assert.deepEqual(kinds.slice(0, 2).sort(), ['failed_agent', 'owed_by_you']);
  assert.ok(kinds.indexOf('dispute') > 1);
  assert.ok(kinds.indexOf('close_call') > kinds.indexOf('dispute'));
  const owed = sitrep.attention.find((item) => item.kind === 'owed_by_you');
  assert.match(owed.do, /^Deliver it, then team_send_message reply_to m_1/);
  assert.match(sitrep.attention.find((item) => item.kind === 'failed_agent').what, /ENOENT/);
  assert.match(sitrep.attention.find((item) => item.kind === 'dispute').what, /500 vs 1000/);
  assert.equal(sitrep.counts.disputes, 1);
  assert.equal(sitrep.counts.open_questions, 1);
});

test('a thread is stalled only after five minutes while its owner keeps running', () => {
  const main = {};
  const registry = agentRegistry(main);
  const a = registerAgent(main, { type: 'general-purpose', description: 'asker', child: { inbox: [] } });
  const b = registerAgent(main, { type: 'general-purpose', description: 'answerer', child: { inbox: [] } });
  sendTeamMessage({ agentTasks: registry, agentId: a.id }, { to: b.id, message: 'Which port?', act: 'request' });
  assert.deepEqual(buildSitrep({ registry }).attention, []);
  registry.dialogue.messages[0].at -= 6 * 60 * 1000;
  const stalled = buildSitrep({ registry }).attention;
  assert.equal(stalled[0].kind, 'stalled_thread');
  assert.match(stalled[0].what, /agent_2 has owed agent_1 a reply to m_1 for 6 min/);
});

test('"none of these" leading asks for the missing hypothesis', () => {
  const board = {};
  runHypothesisTool({}, board, { action: 'open', question: 'Why is the build slow?', hypotheses: ['Cold cache', 'Big lockfile'] }, { actor: 'main', ground: grounded });
  for (const [i, by] of [['1', 'agent_1'], ['2', 'agent_2']]) {
    runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'Warm cache run ' + i + ' still slow with a tiny lockfile', sources: ['https://ci' + i + '.example.com'], ratings: { h_1: '--', h_2: '--' } }, { actor: by, ground: grounded });
  }
  const sitrep = buildSitrep({ registry: agentRegistry({}), board });
  assert.equal(sitrep.attention[0].kind, 'missing_hypothesis');
  assert.equal(sitrep.attention[0].priority, 1);
});

test('team_status without team_id leads with the sitrep', () => {
  const main = { knowledgeBoard: createKnowledgeBoard() };
  const result = agentTeamStatus(main);
  assert.equal(Object.keys(result)[0], 'sitrep');
  assert.ok(result.sitrep.summary);
  const tool = AGENT_TOOL_DEFINITIONS.find((item) => item.function.name === 'team_status');
  assert.match(tool.function.description, /sitrep/);
});

test('a worker calling team_status sees what it owes as its own item', () => {
  const main = {};
  const registry = agentRegistry(main);
  const a = registerAgent(main, { type: 'general-purpose', description: 'asker', child: { inbox: [] } });
  const b = registerAgent(main, { type: 'general-purpose', description: 'answerer', child: { inbox: [] } });
  sendTeamMessage({ agentTasks: registry, agentId: a.id }, { to: b.id, message: 'Which port?', act: 'request' });
  const mine = buildSitrep({ registry, self: b.id }).attention;
  assert.equal(mine[0].kind, 'owed_by_you');
  assert.match(mine[0].do, /team_send_message to "agent_1" .*reply_to "m_1"/);
});
