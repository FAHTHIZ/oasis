import test from 'node:test';
import assert from 'node:assert/strict';
import { RHO, diverseReviewersEnabled, diversityNote, effectiveVotes, lineageRelation, modelLineage, normalizeModel, pickReviewerModel, reviewDiversity, reviewerCandidates } from '../src/verifier-diversity.mjs';
import { assessOutcome, deriveTaskSpec } from '../src/task-model.mjs';
import { noteTaskWorker, recordTaskReview } from '../src/task-reviews.mjs';
import { sanitizeModelRouting } from '../src/model-routing.mjs';
import { diverseReviewerModel } from '../src/agent-subagents.mjs';

test('model ids are placed by lineage through provider prefixes and date tags', () => {
  assert.equal(normalizeModel('openrouter/anthropic/claude-opus-4-5'), 'claude-opus-4-5');
  assert.equal(normalizeModel('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), 'claude-sonnet-4-5');
  assert.equal(normalizeModel('gpt-4o-2024-08-06'), 'gpt-4o');
  assert.equal(normalizeModel('models/gemini-2.5-pro'), 'gemini-2.5-pro');
  assert.equal(normalizeModel('qwen/qwen3-coder:free'), 'qwen3-coder');
  assert.deepEqual(modelLineage('claude-opus-4-5').lineages, ['anthropic']);
  assert.deepEqual(modelLineage('gpt-5.1-codex').lineages, ['openai']);
  assert.deepEqual(modelLineage('o3-mini').lineages, ['openai']);
  assert.deepEqual(modelLineage('gpt-oss-120b').lineages, ['openai']);
  assert.deepEqual(modelLineage('deepseek-r1-distill-qwen-32b').lineages, ['qwen', 'deepseek']);
  assert.deepEqual(modelLineage('llama-3.3-70b-instruct').lineages, ['meta']);
  assert.deepEqual(modelLineage('my-private-model').lineages, []);
});

test('relations: same model, same lineage, different lineage, unknown', () => {
  assert.equal(lineageRelation('anthropic/claude-opus-4-5', 'claude-opus-4-5-20251101'), 'same-model');
  assert.equal(lineageRelation('claude-opus-4-5', 'claude-sonnet-4-5'), 'same-lineage');
  assert.equal(lineageRelation('deepseek-r1-distill-qwen-32b', 'qwen3-coder'), 'same-lineage', 'a distill shares its base model\'s blind spots');
  assert.equal(lineageRelation('claude-opus-4-5', 'gpt-5.1'), 'different-lineage');
  assert.equal(lineageRelation('claude-opus-4-5', 'my-private-model'), 'unknown');
  assert.equal(lineageRelation('', 'gpt-5'), 'unknown');
});

test('Kish effective votes fall as correlation rises', () => {
  assert.equal(effectiveVotes(1, 0.9), 1);
  assert.equal(effectiveVotes(3, 0), 3);
  assert.equal(effectiveVotes(9, 1), 1);
  // Kohli (2026): nine frontier judges ~ two effective votes at rho ~ 0.44.
  assert.ok(Math.abs(effectiveVotes(9, 0.44) - 1.99) < 0.01);
  assert.ok(RHO['same-model'] > RHO['same-lineage'] && RHO['same-lineage'] > RHO['different-lineage']);
});

test('review diversity: a pass on the author model alone is a self-review', () => {
  assert.equal(reviewDiversity([{ by: 'code-review', verdict: 'pass' }], ['gpt-5']), null, 'no model recorded, nothing to say');
  const self = reviewDiversity([{ by: 'code-review a1', verdict: 'pass', model: 'claude-opus-4-5' }], ['claude-opus-4-5']);
  assert.equal(self.selfReview, true);
  assert.equal(self.independence, 0.1);
  assert.equal(self.effectiveVotes, 1);
  const mixed = reviewDiversity([
    { by: 'code-review a1', verdict: 'pass', model: 'claude-opus-4-5' },
    { by: 'verify a2', verdict: 'pass', model: 'gpt-5.1' }
  ], ['claude-opus-4-5']);
  assert.equal(mixed.selfReview, false);
  assert.equal(mixed.diverse, true);
  assert.equal(mixed.independence, 0.6);
  assert.equal(mixed.effectiveVotes, 1.43);
  // The closest author decides.
  const worker = reviewDiversity([{ by: 'verify', verdict: 'pass', model: 'gpt-5.1' }], ['claude-opus-4-5', 'gpt-5.1']);
  assert.equal(worker.reviews[0].relation, 'same-model');
  assert.equal(worker.selfReview, true);
  assert.match(diversityNote(self), /author's own model/);
});

test('the reviewer pick prefers another lineage, then another model of the same one', () => {
  assert.deepEqual(pickReviewerModel('claude-opus-4-5', ['claude-opus-4-5', 'claude-sonnet-4-5', 'gpt-5.1', 'gemini-2.5-pro']), { model: 'gpt-5.1', relation: 'different-lineage' });
  assert.deepEqual(pickReviewerModel('claude-opus-4-5', ['claude-opus-4-5', 'claude-sonnet-4-5']), { model: 'claude-sonnet-4-5', relation: 'same-lineage' });
  assert.equal(pickReviewerModel('claude-opus-4-5', ['claude-opus-4-5', 'my-private-model', 'gpt-*']), null, 'unplaceable and wildcard models are not routed to');
  assert.equal(diverseReviewersEnabled({ modelRouting: { reviewers: 'diverse' } }, {}), true);
  assert.equal(diverseReviewersEnabled({}, { OASIS_REVIEWER_ROUTING: 'diverse' }), true);
  assert.equal(diverseReviewersEnabled({}, {}), false);
  assert.deepEqual(reviewerCandidates({ settings: { modelRouting: { reviewerModels: ['gpt-5.1'], strongModel: 'claude-opus-4-5' } }, availableModels: ['gemini-2.5-pro'] }), ['gpt-5.1', 'claude-opus-4-5', 'gemini-2.5-pro']);
  assert.deepEqual(sanitizeModelRouting({ reviewers: 'diverse', reviewerModels: [' gpt-5.1 ', '', 'gpt-5.1'] }).reviewerModels, ['gpt-5.1']);
  assert.equal(sanitizeModelRouting({ reviewers: 'yes' }).reviewers, undefined);
});

test('diverse reviewer routing honours the model policy and is off by default', () => {
  const parent = { config: { model: 'claude-opus-4-5', protocol: 'openai' }, settings: { modelRouting: { reviewers: 'diverse', reviewerModels: ['gpt-5.1', 'claude-sonnet-4-5'] } }, availableModels: ['claude-opus-4-5', 'claude-sonnet-4-5'] };
  assert.deepEqual(diverseReviewerModel(parent, { env: {} }), { model: 'claude-sonnet-4-5', relation: 'same-lineage' }, 'gpt-5.1 is not in availableModels');
  assert.deepEqual(diverseReviewerModel({ ...parent, availableModels: [] }, { env: {} }), { model: 'gpt-5.1', relation: 'different-lineage' });
  assert.equal(diverseReviewerModel({ ...parent, settings: {} }, { env: {} }), null);
});

test('task outcome: a self-review stays verified; a review on another lineage verifies independently', () => {
  const spec = deriveTaskSpec('Fix the parser bug and make sure the tests pass.');
  const events = [{ seq: 1, kind: 'edit', path: 'a.js' }, { seq: 2, kind: 'check', command: 'npm test', finished: true, passed: true, exitCode: 0 }];
  const base = assessOutcome(spec, { events, reply: 'Tests pass.', reviews: [{ by: 'code-review', verdict: 'pass' }] });
  const self = assessOutcome(spec, { events, reply: 'Tests pass.', reviews: [{ by: 'code-review', verdict: 'pass', model: 'claude-opus-4-5', authors: ['claude-opus-4-5'] }] });
  const diverse = assessOutcome(spec, { events, reply: 'Tests pass.', reviews: [{ by: 'code-review', verdict: 'pass', model: 'gpt-5.1', authors: ['claude-opus-4-5'] }] });
  assert.equal(base.verdict, 'independently_verified');
  assert.equal(self.verdict, 'verified');
  assert.equal(self.independent.selfReview, true);
  assert.equal(diverse.verdict, 'independently_verified');
  assert.equal(self.independent.diversity.selfReview, true);
  assert.equal(diverse.independent.diversity.diverse, true);
  assert.equal(diverse.independent.diversity.reviews[0].relation, 'different-lineage');
  assert.equal(base.independent.diversity, undefined, 'reviews without a model are reported as before');
  const failed = assessOutcome(spec, { events, reply: 'Tests pass.', reviews: [{ by: 'code-review', verdict: 'fail', model: 'claude-opus-4-5', authors: ['claude-opus-4-5'] }] });
  assert.equal(failed.verdict, 'rejected', 'a failing self-review still rejects');
});

test('recorded reviews carry the reviewer model and the author models they judged', () => {
  const session = { task: { id: 't1' }, evidenceLedger: { epoch: 0, seq: 0, events: [] } };
  noteTaskWorker(session, { agentId: 'agent_1', agentType: 'general-purpose', model: 'qwen3-coder' });
  const entry = recordTaskReview(session, { by: 'verify agent_2', model: 'gpt-5.1', authorModel: 'claude-opus-4-5', text: 'Checked src/a.js.\nVERDICT: PASS', finished: true, toolCalls: 3 });
  assert.equal(entry.model, 'gpt-5.1');
  assert.deepEqual(entry.authors.sort(), ['claude-opus-4-5', 'qwen3-coder']);
  const plain = recordTaskReview(session, { by: 'code-review', text: 'VERDICT: PASS', finished: true, toolCalls: 1 });
  assert.equal(plain.model, undefined);
  assert.equal(plain.authors, undefined);
});
