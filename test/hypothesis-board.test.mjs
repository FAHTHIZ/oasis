import test from 'node:test';
import assert from 'node:assert/strict';
import { runHypothesisTool, scoreQuestion, sanitizeMatrix, hypothesisPromptLines, HYPOTHESIS_TOOL_DEFINITION } from '../src/hypothesis-board.mjs';
import { KNOWLEDGE_TOOL_NAMES, runKnowledgeTool, sanitizeKnowledgeBoard, knowledgePromptSection } from '../src/knowledge-board.mjs';

const grounded = () => ({ issues: [], grounds: ['fetched'] });
const ungrounded = () => ({ issues: [], grounds: [] });

function open(board, actor = 'main') {
  return runHypothesisTool({}, board, { action: 'open', question: 'Why does the login test fail on CI only?', hypotheses: ['Timezone difference', 'Race in session setup', 'Missing env var'] }, { actor, ground: grounded });
}

test('the tool is part of the knowledge tools shared with subagents', () => {
  assert.ok(KNOWLEDGE_TOOL_NAMES.has('hypotheses'));
  assert.deepEqual(HYPOTHESIS_TOOL_DEFINITION.function.parameters.required, ['action']);
});

test('opening needs at least two hypotheses and gives a flat prior with room for none of these', () => {
  const board = {};
  assert.throws(() => runHypothesisTool({}, board, { action: 'open', question: 'q', hypotheses: ['only one'] }), /at least two/);
  const result = open(board);
  assert.equal(result.opened, 'q_1');
  assert.deepEqual(result.hypotheses.map((h) => h.id).sort(), ['h_1', 'h_2', 'h_3']);
  assert.equal(result.hypotheses[0].posterior, 0.3);
  assert.equal(result.none_of_these, 0.1);
  assert.match(result.advice.join(' '), /Untested: /);
});

test('disconfirming evidence moves the posterior; evidence that fits everything moves nothing', () => {
  const board = {};
  open(board);
  const flat = runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'The test fails', ratings: { h_1: '+', h_2: '+', h_3: '+' } }, { actor: 'agent_1', ground: grounded });
  assert.equal(flat.evidence[0].diagnosticity, 1);
  assert.equal(flat.hypotheses[0].posterior, 0.3);
  assert.match(flat.advice.join(' '), /Non-diagnostic .*e_1/);
  const sharp = runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'Fails with TZ=UTC locally too', sources: ['https://ci.example.com/run/1'], ratings: { h_1: '--', h_2: '+', h_3: '0' } }, { actor: 'agent_2', ground: grounded });
  const byId = Object.fromEntries(sharp.hypotheses.map((h) => [h.id, h]));
  assert.ok(byId.h_2.posterior > byId.h_3.posterior && byId.h_3.posterior > byId.h_1.posterior);
  assert.equal(byId.h_1.inconsistency, 2);
});

test('ungrounded, repeated-source and self-confirming evidence count less', () => {
  const board = {};
  open(board, 'agent_1');
  const first = runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'A blog says races are common', sources: ['https://blog.example.com/a'], ratings: { h_2: '++' } }, { actor: 'agent_2', ground: ungrounded });
  assert.equal(first.weight, 0.5);
  assert.match(first.weight_reason, /not backed/);
  assert.deepEqual(first.unrated, ['h_1', 'h_3']);
  const again = runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'Same blog, other post', sources: ['https://www.example.com/b'], ratings: { h_2: '++', h_1: '-', h_3: '-' } }, { actor: 'agent_3', ground: grounded });
  assert.equal(again.weight, 0.5);
  assert.match(again.weight_reason, /repeats a source/);
  // agent_1 proposed every hypothesis: its support for one counts half.
  const own = { hypotheses: [{ id: 'h_1', by: 'agent_1', prior: 1 }, { id: 'h_2', by: 'agent_9', prior: 1 }], evidence: [{ id: 'e_1', by: 'agent_1', weight: 1, ratings: { h_1: '++' } }] };
  const other = { hypotheses: [{ id: 'h_1', by: 'agent_9', prior: 1 }, { id: 'h_2', by: 'agent_9', prior: 1 }], evidence: [{ id: 'e_1', by: 'agent_1', weight: 1, ratings: { h_1: '++' } }] };
  assert.ok(scoreQuestion(own).posterior.get('h_1') < scoreQuestion(other).posterior.get('h_1'));
});

test('evidence against every listed hypothesis raises none of these and asks for the missing one', () => {
  const board = {};
  open(board);
  let result;
  for (const [index, site] of ['https://a.example.org/1', 'https://b.example.net/2', 'https://c.example.com/3'].entries()) {
    result = runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'Ruled out ' + index, sources: [site], ratings: { h_1: '--', h_2: '--', h_3: '--' } }, { actor: 'agent_' + (index + 1), ground: grounded });
  }
  assert.ok(result.none_of_these > 0.5);
  assert.match(result.advice.join(' '), /None of these.*Add the hypothesis you are missing/);
  const added = runHypothesisTool({}, board, { action: 'add', question: 'q_1', hypothesis: 'Stale cache on the CI runner' }, { actor: 'agent_4', ground: grounded });
  assert.equal(added.added, 'h_4');
});

test('a question only leads with a clear posterior from two agents and two independent sources', () => {
  const board = {};
  open(board);
  const post = (actor, site) => runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'Session token is read before it is written (' + site + ')', sources: [site], ratings: { h_1: '--', h_2: '++', h_3: '--' } }, { actor, ground: grounded });
  const one = post('agent_1', 'https://github.com/acme/app/issues/1');
  const two = post('agent_1', 'https://docs.example.com/race');
  assert.equal(two.state, 'open');
  assert.match(two.advice.join(' '), /h_2 leads, but on one agent's evidence/);
  assert.equal(one.state, 'open');
  const three = post('agent_2', 'https://ci.example.org/log');
  assert.equal(three.state, 'leading');
  assert.equal(three.leading, 'h_2');
  const resolved = runHypothesisTool({}, board, { action: 'resolve', question: 'q_1', hypothesis: 'h_3', reason: 'gut feeling' }, { actor: 'main' });
  assert.equal(resolved.state, 'resolved');
  assert.match(resolved.warning, /Resolved against the evidence: h_2/);
  assert.throws(() => runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'late', ratings: { h_1: '+' } }, { ground: grounded }), /resolved/);
});

test('bad ids and ratings are refused; refused grounding is refused', () => {
  const board = {};
  open(board);
  assert.throws(() => runHypothesisTool({}, board, { action: 'evidence', question: 'q_9', evidence: 'x', ratings: { h_1: '+' } }), /Unknown question q_9/);
  assert.throws(() => runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'x', ratings: { h_7: '+' } }), /Unknown hypothesis h_7/);
  assert.throws(() => runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'x', ratings: { h_1: 'maybe' } }), /one of \+\+/);
  assert.throws(() => runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'x', ratings: {} }), /Rate the evidence/);
  assert.throws(() => runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'All tests pass', ratings: { h_1: '+' } }, { ground: () => ({ issues: [{ reason: 'the report claims a passing check' }], grounds: [] }) }), /Not posted: the evidence claims/);
});

test('the matrix is shared through the knowledge board, saved with it and shown to starting subagents', () => {
  const session = { knowledgeBoard: sanitizeKnowledgeBoard({}), agentId: 'agent_1' };
  runKnowledgeTool(session, 'hypotheses', { action: 'open', question: 'Which library is faster?', hypotheses: ['libA', 'libB'] });
  const child = { knowledgeBoard: session.knowledgeBoard, agentId: 'agent_2' };
  const status = runKnowledgeTool(child, 'hypotheses', { action: 'status' });
  assert.equal(status.questions[0].hypotheses[0].by, 'agent_1');
  const saved = sanitizeKnowledgeBoard(JSON.parse(JSON.stringify(session.knowledgeBoard)));
  assert.equal(saved.hypotheses.questions[0].text, 'Which library is faster?');
  assert.equal(sanitizeMatrix(saved.hypotheses).nextH, 3);
  assert.match(hypothesisPromptLines(saved), /q_1 Which library is faster\?: h_1 libA \(0\.45\)/);
  assert.match(knowledgePromptSection({ knowledgeBoard: saved }, 'benchmark'), /Open questions on the hypotheses matrix/);
});

test('resolving by the coordinator scores each evidence rating as a forecast', async () => {
  const { createCalibrationLedger } = await import('../src/calibration.mjs');
  const { raterForecasts } = await import('../src/hypothesis-board.mjs');
  const ledger = createCalibrationLedger();
  const board = { uid: 'abcdef0123' };
  open(board);
  const post = (actor, model, ratings) => runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'obs by ' + actor, ratings }, { actor, model, type: 'researcher', ground: grounded, ledger });
  post('agent_1', 'good-model', { h_1: '--', h_2: '++', h_3: '-' });
  post('agent_2', 'bad-model', { h_1: '++', h_2: '-', h_3: '0' });
  post('agent_3', 'bad-model', { h_1: '+', h_2: '+', h_3: '+' });
  const forecasts = raterForecasts(board.hypotheses.questions[0], 'h_2');
  assert.deepEqual(forecasts.map((item) => [item.by, item.favoured, item.o]), [['agent_1', 'h_2', 1], ['agent_2', 'h_1', 0]]);
  assert.equal(forecasts[0].p, 0.842);
  // A subagent resolving does not score anyone.
  const copy = JSON.parse(JSON.stringify(board));
  runHypothesisTool({}, copy, { action: 'resolve', question: 'q_1', hypothesis: 'h_2' }, { actor: 'agent_1', ledger });
  assert.equal(ledger.records().length, 0);
  const result = runHypothesisTool({}, board, { action: 'resolve', question: 'q_1', hypothesis: 'h_2' }, { actor: 'main', ledger });
  assert.match(result.calibration, /2 evidence ratings scored/);
  assert.deepEqual(ledger.records({ model: 'bad-model' }).map((item) => [item.o, item.kind, item.type]), [[0, 'hypothesis', 'researcher']]);
  assert.equal(ledger.records({ model: 'good-model' })[0].o, 1);
});

test('resolved questions become base rates for similar new questions', async () => {
  const { createHypothesisHistory, basePriors } = await import('../src/hypothesis-history.mjs');
  const history = createHypothesisHistory();
  for (const [index, answer] of ['Missing environment variable on CI', 'Missing environment variable on CI', 'Race in session setup'].entries()) {
    const board = { uid: 'board' + index + 'abcdef' };
    runHypothesisTool({}, board, { action: 'open', question: 'Why does the login test fail on CI only?', hypotheses: ['Missing environment variable on CI', 'Race in session setup', 'Timezone difference on the runner'] }, { actor: 'main', history });
    const choice = board.hypotheses.questions[0].hypotheses.find((h) => h.text === answer).id;
    runHypothesisTool({}, board, { action: 'resolve', question: 'q_1', hypothesis: choice }, { actor: 'main', history });
  }
  assert.equal(history.cases().length, 3);
  const board = {};
  const opened = runHypothesisTool({}, board, { action: 'open', question: 'Why does the signup test fail on CI only?', hypotheses: ['Timezone difference on the runner', 'A missing environment variable on CI', 'Race in session setup'] }, { actor: 'main', history });
  const byText = Object.fromEntries(opened.hypotheses.map((h) => [h.text, h]));
  assert.ok(byText['A missing environment variable on CI'].posterior > byText['Race in session setup'].posterior);
  assert.ok(byText['Race in session setup'].posterior > byText['Timezone difference on the runner'].posterior);
  assert.match(byText['A missing environment variable on CI'].base_rate, /^prior x\d/);
  // An unrelated question has no reference class.
  assert.deepEqual(basePriors('Which database should the billing service use?', ['Postgres', 'MySQL'], history.cases()).map((item) => item.prior), [1, 1]);
  // Subagents resolving do not write history.
  const child = {};
  runHypothesisTool({}, child, { action: 'open', question: 'Why does the login test fail on CI only?', hypotheses: ['a b c', 'd e f'] }, { actor: 'agent_1', history });
  runHypothesisTool({}, child, { action: 'resolve', question: 'q_1', hypothesis: 'h_1' }, { actor: 'agent_1', history });
  assert.equal(history.cases().length, 3);
});

test('evidence is weighted by the rater model\'s track record on resolved questions', async () => {
  const { createCalibrationLedger } = await import('../src/calibration.mjs');
  const { raterTrack } = await import('../src/hypothesis-board.mjs');
  const ledger = createCalibrationLedger();
  assert.equal(raterTrack(ledger, 'model-a'), null, 'no record, no adjustment');
  for (let i = 0; i < 8; i++) {
    ledger.record({ id: 'bad' + i, model: 'model-bad', p: 0.9, o: 0, kind: 'hypothesis' });
    ledger.record({ id: 'good' + i, model: 'model-good', p: 0.6, o: 1, kind: 'hypothesis' });
    ledger.record({ id: 'other' + i, model: 'model-other', p: 0.9, o: 0, kind: 'retracted' });
  }
  assert.equal(raterTrack(ledger, 'model-bad').factor, 0.4);
  assert.ok(raterTrack(ledger, 'model-good').factor > 1.3);
  assert.equal(raterTrack(ledger, 'model-other'), null, 'only hypothesis outcomes count');
  const board = {};
  open(board);
  const bad = runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'TZ=UTC fixes it', sources: ['https://a.example.com/1'], ratings: { h_1: '++', h_2: '-', h_3: '-' } }, { actor: 'agent_1', ground: grounded, model: 'model-bad', ledger });
  assert.equal(bad.weight, 0.4);
  assert.match(bad.weight_reason, /down-weighted x0.4: evidence from model-bad pointed at the answer 0 of 8 times/);
  const good = runHypothesisTool({}, board, { action: 'evidence', question: 'q_1', evidence: 'Setup race visible in trace', sources: ['https://trace.example.org/1'], ratings: { h_1: '-', h_2: '++', h_3: '-' } }, { actor: 'agent_2', ground: grounded, model: 'model-good', ledger });
  assert.ok(good.weight > 1.3 && good.weight <= 1.5);
  const byId = Object.fromEntries(good.hypotheses.map((h) => [h.id, h]));
  assert.ok(byId.h_2.posterior > byId.h_1.posterior, 'the reliable rater outweighs the unreliable one');
  const restored = sanitizeMatrix(JSON.parse(JSON.stringify(board.hypotheses)));
  assert.equal(restored.questions[0].evidence[1].weight, good.weight, 'weights above 1 survive a save');
});

test('plan ranks candidate tests by expected information before any are run', async () => {
  const { planTests } = await import('../src/hypothesis-board.mjs');
  const board = {};
  open(board);
  const result = runHypothesisTool({}, board, { action: 'plan', question: 'q_1', tests: [
    { test: 'Rerun the test on CI', predictions: { h_1: '++', h_2: '++', h_3: '++' } },
    { test: 'Run locally with TZ=UTC', predictions: { h_1: '++', h_2: '--', h_3: '--' } },
    { test: 'Run with the env var set on CI', predictions: { h_1: '+', h_2: '+', h_3: '--' } }
  ] }, { actor: 'main', ground: grounded });
  assert.equal(result.tests.length, 3);
  assert.ok(result.uncertainty_bits > 1.5);
  assert.equal(result.tests[2].test, 'Rerun the test on CI');
  assert.ok(result.tests[2].expected_bits < result.tests[0].expected_bits);
  assert.ok(result.tests[0].expected_bits > 0.5);
  assert.match(result.advice, /^Run "/);
  const separating = result.tests.find((item) => item.test === 'Run locally with TZ=UTC');
  assert.match(separating.if_positive, /^h_1 0\.\d+/);
  const same = planTests(board.hypotheses.questions[0], [{ test: 'Look at the logo', predictions: {} }]);
  assert.equal(same.tests[0].expected_bits, 0);
  assert.match(same.tests[0].note, /moves nothing/);
  assert.match(same.advice, /None of these tests separates/);
  assert.throws(() => runHypothesisTool({}, board, { action: 'plan', question: 'q_1', tests: [{ test: 'x', predictions: { h_9: '+' } }] }), /Unknown hypothesis h_9/);
  assert.throws(() => runHypothesisTool({}, board, { action: 'plan', question: 'q_1' }), /plan needs tests/);
});
