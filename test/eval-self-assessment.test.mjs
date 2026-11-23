import test from 'node:test';
import assert from 'node:assert/strict';
import { describeSelfAssessment, summarizeSelfAssessment, trialSelfAssessment } from '../src/eval.mjs';

const result = (verdict, finished = true) => ({ finished, task: { outcome: { verdict } } });

test('a trial self-assessment reduces the OASIS verdict to a claim', () => {
  assert.deepEqual(trialSelfAssessment(result('verified')), { verdict: 'verified', claim: 'success' });
  assert.deepEqual(trialSelfAssessment(result('independently_verified')), { verdict: 'independently_verified', claim: 'success' });
  assert.equal(trialSelfAssessment(result('rejected')).claim, 'failure');
  assert.equal(trialSelfAssessment(result('incomplete')).claim, 'failure');
  assert.equal(trialSelfAssessment(result('evidenced')).claim, 'unsure');
  assert.equal(trialSelfAssessment(result('unverified')).claim, 'unsure');
  // A run that said its verification was incomplete never claimed success.
  assert.equal(trialSelfAssessment(result('verified', false)).claim, 'failure');
  assert.deepEqual(trialSelfAssessment({ finished: true }), { verdict: null, claim: 'none' });
  assert.deepEqual(trialSelfAssessment(null), { verdict: null, claim: 'none' });
  // An empty reply is OASIS reporting that it has nothing, not a silent pass.
  assert.deepEqual(trialSelfAssessment({ finished: true, emptyReply: true }), { verdict: null, claim: 'failure', reason: 'empty reply' });
});

test('self-assessment counts overclaims and underclaims against the hidden verifier', () => {
  const row = (claim, status) => ({ status, selfAssessment: { verdict: 'x', claim } });
  const stats = summarizeSelfAssessment([
    row('success', 'passed'), row('success', 'passed'), row('success', 'failed'),
    row('failure', 'failed'), row('failure', 'passed'),
    row('unsure', 'passed'), row('none', 'failed'), { status: 'failed' }
  ]);
  assert.equal(stats.assessed, 6);
  assert.equal(stats.notAssessed, 2);
  assert.equal(stats.truePositive, 2);
  assert.equal(stats.overclaims, 1);
  assert.equal(stats.trueNegative, 1);
  assert.equal(stats.underclaims, 1);
  assert.deepEqual(stats.unsure, { passed: 1, failed: 0 });
  assert.equal(stats.agreement, 0.6);
  assert.equal(stats.successPrecision, 0.667);
  assert.match(describeSelfAssessment(stats), /6 trials with an OASIS verdict · 60% agree with the verifier · 1 overclaim · 1 underclaim · 1 unsure/);
});

test('self-assessment with no verdicts says nothing', () => {
  const stats = summarizeSelfAssessment([{ status: 'passed', selfAssessment: { verdict: null, claim: 'none' } }]);
  assert.equal(stats.assessed, 0);
  assert.equal(stats.agreement, null);
  assert.equal(stats.successPrecision, null);
  assert.equal(describeSelfAssessment(stats), '');
  assert.equal(summarizeSelfAssessment([]).assessed, 0);
});
