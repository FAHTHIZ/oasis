import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { calibrate, calibrationTable, createCalibrationLedger, formatCalibrationTable, parseConfidence, reliability, scoreForecasts } from '../src/calibration.mjs';
import { createEvidenceLedger, recordEvidence } from '../src/evidence-ledger.mjs';
import { createKnowledgeBoard, runKnowledgeTool, knowledgePromptSection, sanitizeKnowledgeBoard, searchKnowledge } from '../src/knowledge-board.mjs';

function agent(id, model, ledger, board, events = []) {
  const evidence = createEvidenceLedger();
  for (const event of events) recordEvidence(evidence, event);
  return { agentId: id, agentType: 'Explore', config: { model }, evidenceLedger: evidence, knowledgeBoard: board, calibrationLedger: ledger };
}

test('stated confidences parse from numbers, percentages and words', () => {
  assert.equal(parseConfidence(0.8), 0.8);
  assert.equal(parseConfidence('85%'), 0.85);
  assert.equal(parseConfidence(70), 0.7);
  assert.equal(parseConfidence('likely'), 0.75);
  assert.equal(parseConfidence(''), null);
  assert.equal(parseConfidence(-1), null);
  assert.equal(parseConfidence(250), null);
  assert.equal(parseConfidence('banana'), null);
});

test('Brier score, overconfidence and the reliability table', () => {
  const perfect = scoreForecasts([{ p: 1, o: 1 }, { p: 0, o: 0 }]);
  assert.equal(perfect.brier, 0);
  const coin = scoreForecasts([{ p: 0.5, o: 1 }, { p: 0.5, o: 0 }]);
  assert.equal(coin.brier, 0.25);
  const brash = scoreForecasts(Array.from({ length: 10 }, (_, i) => ({ p: 0.95, o: i < 5 ? 1 : 0 })));
  assert.ok(brash.overconfidence > 0.4, 'says 95% but holds half the time');
  assert.equal(brash.hitRate, 0.5);
  const bins = reliability([{ p: 0.1, o: 0 }, { p: 0.9, o: 1 }, { p: 0.92, o: 0 }]);
  assert.deepEqual(bins.map((bin) => bin.range), ['0.0-0.2', '0.8-1.0']);
  assert.equal(bins[1].held, 0.5);
  assert.equal(scoreForecasts([]).n, 0);
});

test('calibrate pulls a stated p toward what it has meant, and leaves a thin record alone', () => {
  const brash = Array.from({ length: 30 }, (_, i) => ({ p: 0.95, o: i % 2 }));
  const pulled = calibrate(0.95, brash);
  assert.ok(pulled.adjusted);
  assert.ok(pulled.p < 0.65 && pulled.p > 0.45, 'about the 50% it actually held: ' + pulled.p);
  const honest = Array.from({ length: 30 }, (_, i) => ({ p: 0.8, o: i % 5 === 0 ? 0 : 1 }));
  assert.ok(Math.abs(calibrate(0.8, honest).p - 0.8) < 0.02, 'a calibrated model keeps its word');
  const thin = calibrate(0.9, brash.slice(0, 3));
  assert.deepEqual(thin, { p: 0.9, n: 3, adjusted: false });
  // Far-away forecasts barely inform a different confidence level.
  const low = calibrate(0.2, brash);
  assert.ok(Math.abs(low.p - 0.2) < 0.06, 'a record at 0.95 says little about 0.2: ' + low.p);
});

test('the ledger persists, replaces by id and survives a corrupt file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-calibration-'));
  try {
    const file = path.join(dir, 'calibration.json');
    const ledger = createCalibrationLedger({ file });
    ledger.record({ id: 'b:k_1', model: 'm1', p: 0.9, o: 1, kind: 'corroborated' });
    ledger.record({ id: 'b:k_1', model: 'm1', p: 0.9, o: 0, kind: 'retracted' });
    ledger.record({ id: 'b:k_2', model: 'm2', p: 0.6, o: 1 });
    assert.equal(ledger.record({ id: 'b:k_3', p: 2, o: 1 }), null);
    const again = createCalibrationLedger({ file });
    assert.deepEqual(again.records({ model: 'm1' }).map((item) => [item.o, item.kind]), [[0, 'retracted']]);
    assert.equal(again.records().length, 2);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).version, 1);
    assert.equal(again.forget({ model: 'm2' }), 1);
    const table = calibrationTable(again.records());
    assert.equal(table[0].model, 'm1');
    assert.match(formatCalibrationTable(table), /m1: 1 settled, Brier 0\.810/);
    await (await import('node:fs/promises')).writeFile(file, '{not json');
    assert.deepEqual(createCalibrationLedger({ file }).records(), []);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('board findings settle into the ledger: corroborated holds, withdrawn and lost disputes fail', () => {
  const ledger = createCalibrationLedger();
  const board = createKnowledgeBoard();
  const fetchedLimits = [{ kind: 'fetch', tool: 'fetch_url', url: 'https://example.com/limits', numbers: ['500', '1000'] }];
  const alice = agent('agent_1', 'brash-model', ledger, board, fetchedLimits);
  const bob = agent('agent_2', 'careful-model', ledger, board, fetchedLimits);
  const main = { agentId: '', knowledgeBoard: board, calibrationLedger: ledger };

  assert.throws(() => runKnowledgeTool(alice, 'knowledge_post', { claim: 'x is so', confidence: 'very' }), /confidence must be a probability/);

  const held = runKnowledgeTool(alice, 'knowledge_post', { claim: 'Rate limits are documented on the limits page of the example API.', sources: ['https://example.com/limits'], confidence: 0.95 });
  assert.equal(held.finding.confidence, 0.95);
  runKnowledgeTool(bob, 'knowledge_post', { claim: 'Rate limits are documented on the limits page of the example API.', sources: ['https://example.com/limits'] });
  assert.equal(board.entries[0].settled.kind, 'corroborated');
  assert.deepEqual(ledger.records().map((item) => [item.model, item.p, item.o]), [['brash-model', 0.95, 1]]);

  // A dispute: alice says 500, bob says 1000; alice's side is retracted by main.
  const wrong = runKnowledgeTool(alice, 'knowledge_post', { claim: 'The example API allows 500 requests per minute per key.', sources: ['https://example.com/limits'], confidence: 0.9 });
  const right = runKnowledgeTool(bob, 'knowledge_post', { claim: 'The example API allows 1000 requests per minute per key.', sources: ['https://example.com/limits'], confidence: 0.7 });
  assert.equal(right.contested, true);
  runKnowledgeTool(main, 'knowledge_post', { retract: wrong.posted, reason: 'the page says 1000' });
  const byId = Object.fromEntries(ledger.records().map((item) => [item.id.split(':')[1], item]));
  assert.equal(byId[wrong.posted].o, 0);
  assert.equal(byId[wrong.posted].kind, 'lost-dispute');
  assert.equal(byId[right.posted].o, 1);
  assert.equal(byId[right.posted].kind, 'won-dispute');

  // Withdrawing your own finding is a failed forecast; a failure is final.
  const own = runKnowledgeTool(alice, 'knowledge_post', { claim: 'The limits page was last updated in March.', confidence: 0.8 });
  runKnowledgeTool(alice, 'knowledge_post', { retract: own.posted });
  assert.equal(board.entries.find((item) => item.id === own.posted).settled.kind, 'withdrawn');
  const unsure = runKnowledgeTool(bob, 'knowledge_post', { claim: 'Batch endpoints probably share the per-key limit.' });
  runKnowledgeTool(bob, 'knowledge_post', { retract: unsure.posted });
  assert.equal(ledger.records().length, 4, 'a finding without a stated confidence settles but is not a forecast');

  // Settlement survives a save and restore.
  const restored = sanitizeKnowledgeBoard(JSON.parse(JSON.stringify(board)));
  assert.equal(restored.uid, board.uid);
  assert.equal(restored.entries.find((item) => item.id === wrong.posted).settled.outcome, 0);
  assert.equal(restored.entries[0].model, 'brash-model');
});

test('a model with a poor record is shown and ranked by its calibrated confidence', () => {
  const ledger = createCalibrationLedger();
  for (let i = 0; i < 20; i++) ledger.record({ id: 'old:k_' + (i + 1), model: 'brash-model', p: 0.95, o: i < 8 ? 1 : 0 });
  for (let i = 0; i < 20; i++) ledger.record({ id: 'old2:k_' + (i + 1), model: 'careful-model', p: 0.7, o: i < 14 ? 1 : 0 });
  const board = createKnowledgeBoard();
  const alice = agent('agent_1', 'brash-model', ledger, board);
  const bob = agent('agent_2', 'careful-model', ledger, board);
  const a = runKnowledgeTool(alice, 'knowledge_post', { claim: 'The cache layer drops writes under heavy load.', confidence: 0.95 });
  const b = runKnowledgeTool(bob, 'knowledge_post', { claim: 'Under heavy load the write path backs up in a bounded queue instead.', confidence: 0.7 });
  assert.ok(a.finding.calibrated_confidence < 0.55, 'brash 0.95 reads as ~0.4: ' + a.finding.calibrated_confidence);
  assert.match(a.finding.calibration, /brash-model's findings at that confidence have held about \d+% of the time \(20 settled\)/);
  assert.equal(b.finding.calibrated_confidence, undefined, 'a model that keeps its word is not adjusted');
  const ranked = searchKnowledge(board, { query: 'heavy load' });
  assert.equal(ranked[0].id, b.posted, 'the careful 0.7 outranks the brash 0.95');
  const section = knowledgePromptSection({ knowledgeBoard: board, calibrationLedger: ledger }, 'cache writes under load');
  assert.match(section, /confidence 0\.95 \(calibrated 0\.\d+\)/);
  assert.match(section, /confidence 0\.7\]/);
});

test('calibration can be turned off', async () => {
  const { sharedCalibrationLedger, calibrationEnabled } = await import('../src/calibration.mjs');
  assert.equal(sharedCalibrationLedger({ OASIS_CALIBRATION: '0' }), null);
  assert.equal(calibrationEnabled({}, { calibration: false }), false);
  const board = createKnowledgeBoard();
  const posted = runKnowledgeTool({ agentId: 'agent_1', knowledgeBoard: board, calibrationLedger: null }, 'knowledge_post', { claim: 'Something plain.', confidence: 0.6 });
  assert.equal(posted.finding.confidence, 0.6);
  runKnowledgeTool({ agentId: 'agent_1', knowledgeBoard: board, calibrationLedger: null }, 'knowledge_post', { retract: posted.posted });
  assert.equal(board.entries[0].settled.outcome, 0);
});
