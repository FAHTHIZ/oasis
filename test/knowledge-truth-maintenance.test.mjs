import assert from 'node:assert/strict';
import test from 'node:test';
import { createEvidenceLedger, recordEvidence } from '../src/evidence-ledger.mjs';
import { createKnowledgeBoard, fallenPremises, runKnowledgeTool, sanitizeKnowledgeBoard, underminedFindings, KNOWLEDGE_TOOL_DEFINITIONS } from '../src/knowledge-board.mjs';
import { agentRegistry, registerAgent } from '../src/agent-tasks.mjs';
import { buildSitrep } from '../src/team-sitrep.mjs';

function as(id, board, extra = {}) {
  const ledger = createEvidenceLedger();
  for (const url of ['https://a.example.com/x', 'https://b.example.org/y', 'https://c.example.net/z']) recordEvidence(ledger, { kind: 'fetch', tool: 'fetch_url', url });
  return { agentId: id, agentType: 'Explore', evidenceLedger: ledger, knowledgeBoard: board, ...extra };
}
const post = (session, claim, more = {}) => runKnowledgeTool(session, 'knowledge_post', { claim, sources: ['https://a.example.com/x'], ...more });

test('knowledge_post takes builds_on and the view lists the premises', () => {
  const tool = KNOWLEDGE_TOOL_DEFINITIONS.find((item) => item.function.name === 'knowledge_post');
  assert.ok(tool.function.parameters.properties.builds_on);
  const board = createKnowledgeBoard();
  post(as('agent_1', board), 'The service reads its config from /etc/svc.yaml.');
  const derived = post(as('agent_2', board), 'Changing /etc/svc.yaml needs a restart to take effect.', { builds_on: ['k_1'] });
  assert.deepEqual(derived.finding.builds_on, ['k_1']);
  assert.equal(derived.finding.undermined, undefined);
  assert.throws(() => post(as('agent_2', board), 'Another conclusion entirely about logs.', { builds_on: ['k_9'] }), /Unknown finding k_9/);
});

test('retracting a premise undermines every finding built on it, transitively, and tells running authors', () => {
  const main = { knowledgeBoard: createKnowledgeBoard() };
  const registry = agentRegistry(main);
  const a = registerAgent(main, { type: 'Explore', description: 'config reader', child: { inbox: [] } });
  const b = registerAgent(main, { type: 'Explore', description: 'ops reasoner', child: { inbox: [] } });
  const board = main.knowledgeBoard;
  const shared = { agentTasks: registry };
  post(as(a.id, board, shared), 'The service reads its config from /etc/svc.yaml.');
  post(as(b.id, board, shared), 'Changing /etc/svc.yaml needs a restart to take effect.', { builds_on: ['k_1'] });
  post(as('main', board, shared), 'The deploy runbook must restart the service after config edits.', { builds_on: ['k_2'] });
  post(as(b.id, board, shared), 'The service logs to journald by default.');

  const retracted = runKnowledgeTool(as(a.id, board, shared), 'knowledge_post', { retract: 'k_1', reason: 'it actually reads /opt/svc/config.yaml' });
  assert.deepEqual(retracted.undermines, ['k_2', 'k_3']);
  assert.match(retracted.note, /This undermines k_2 \(agent_2\), k_3 \(main\)/);
  const inbox = b.child.inbox.map((item) => item.text).join('\n');
  assert.match(inbox, /Your finding k_2 .* builds on k_1, which agent_1 just retracted \(it actually reads \/opt\/svc\/config\.yaml\)/);

  const third = board.entries.find((entry) => entry.id === 'k_3');
  assert.deepEqual(fallenPremises(board, third), [{ id: 'k_1', by: 'agent_1', reason: 'it actually reads /opt/svc/config.yaml', via: ['k_2'] }]);
  const found = runKnowledgeTool(as('main', board), 'knowledge_search', { status: 'undermined' });
  const ids = (found.findings || found.results || []).map((item) => item.id).sort();
  assert.deepEqual(ids, ['k_2', 'k_3']);
  const view = (found.findings || found.results).find((item) => item.id === 'k_3');
  assert.match(view.undermined, /^Rests on k_1 \(via k_2\), retracted by agent_1: it actually reads/);
  assert.equal(underminedFindings(board).length, 2);

  const sitrep = buildSitrep({ registry, board });
  assert.deepEqual(sitrep.attention.filter((item) => item.kind === 'undermined').map((item) => item.ref).sort(), ['k_2', 'k_3']);
});

test('search ranks an undermined finding below an equal one, and the links survive a save', () => {
  const board = createKnowledgeBoard();
  post(as('agent_1', board), 'Port 8080 is used by the admin API.');
  post(as('agent_2', board), 'The admin API needs auth on port 8080 behind the proxy.', { builds_on: ['k_1'] });
  post(as('agent_3', board), 'The admin API needs auth on port 8080 per the security doc.', { sources: ['https://b.example.org/y'] });
  runKnowledgeTool(as('agent_1', board), 'knowledge_post', { retract: 'k_1', reason: 'wrong service' });
  const results = runKnowledgeTool(as('main', board), 'knowledge_search', { query: 'admin API auth port 8080' });
  const list = results.findings || results.results;
  assert.ok(list.findIndex((item) => item.id === 'k_3') < list.findIndex((item) => item.id === 'k_2'));
  const restored = sanitizeKnowledgeBoard(JSON.parse(JSON.stringify(board)));
  assert.equal(fallenPremises(restored, restored.entries.find((entry) => entry.id === 'k_2')).length, 1);
});

test('a contested premise makes the conclusion shaky without undermining it', () => {
  const board = createKnowledgeBoard();
  post(as('agent_1', board), 'The API allows 500 requests per minute.');
  post(as('agent_2', board), 'A batch of 400 requests per minute stays under the API limit.', { builds_on: ['k_1'] });
  post(as('agent_3', board), 'The API allows 300 requests per minute.', { sources: ['https://b.example.org/y'] });
  const view = runKnowledgeTool(as('main', board), 'knowledge_search', { query: 'batch 400 requests' });
  const item = (view.findings || view.results).find((entry) => entry.id === 'k_2');
  assert.deepEqual(item.premise_contested, ['k_1']);
  assert.equal(item.undermined, undefined);
});

test('hypotheses evidence that cites a retracted finding, or one it undermines, stops counting', async () => {
  const { runHypothesisTool } = await import('../src/hypothesis-board.mjs');
  const board = createKnowledgeBoard();
  post(as('agent_1', board), 'The CI runner uses TZ=America/New_York.');
  post(as('agent_2', board), 'Date parsing in the login test depends on the local timezone.', { builds_on: ['k_1'] });
  runKnowledgeTool(as('main', board), 'hypotheses', { action: 'open', question: 'Why does login fail on CI?', hypotheses: ['Timezone difference', 'Race in session setup'] });
  const hyp = (id, args) => runKnowledgeTool(as(id, board), 'hypotheses', args);
  assert.throws(() => hyp('agent_2', { action: 'evidence', question: 'q_1', evidence: 'x', ratings: { h_1: '+' }, findings: ['k_9'] }), /Unknown finding k_9/);
  const before = hyp('agent_2', { action: 'evidence', question: 'q_1', evidence: 'The runner timezone differs from local', sources: ['https://a.example.com/x'], findings: ['k_2'], ratings: { h_1: '++', h_2: '0' } });
  const leaderBefore = before.hypotheses[0];
  assert.equal(leaderBefore.id, 'h_1');
  const retracted = runKnowledgeTool(as('agent_1', board), 'knowledge_post', { retract: 'k_1', reason: 'the runner is UTC' });
  assert.deepEqual(retracted.voided_evidence, ['q_1/e_1']);
  assert.match(retracted.note, /Hypotheses evidence that cited it no longer counts: q_1\/e_1/);
  const after = hyp('main', { action: 'status', question: 'q_1' });
  assert.equal(after.hypotheses[0].posterior, after.hypotheses[1].posterior, 'back to the prior');
  assert.match(after.evidence[0].voided, /cites k_2, undermined by agent_1's retraction: builds on k_1 \(the runner is UTC\)/);
  assert.match(after.advice.join(' '), /No longer counted: e_1 \(cites k_2, undermined\)/);
  const saved = sanitizeKnowledgeBoard(JSON.parse(JSON.stringify(board)));
  assert.equal(saved.hypotheses.questions[0].evidence[0].voided.undermined, true);
  void runHypothesisTool;
});
