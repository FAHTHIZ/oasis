import test from 'node:test';
import assert from 'node:assert/strict';
import { parseReviewArgs, reviewPrompt, runBuiltinCommand } from '../src/slash.mjs';

test('parses /code-review options', () => {
  assert.deepEqual(parseReviewArgs(''), { effort: 'medium', fix: false, comment: false, maxFindings: null, target: '' });
  assert.deepEqual(parseReviewArgs('high --fix --max-findings 3 #42'), { effort: 'high', fix: true, comment: false, maxFindings: 3, target: '#42' });
  assert.equal(parseReviewArgs('--max-findings all main').maxFindings, Infinity);
  assert.equal(parseReviewArgs('ultra --comment src/app').target, 'src/app');
});

test('effort levels scale reviewers and verification', () => {
  assert.doesNotMatch(reviewPrompt('review', 'low'), /subagents/);
  assert.match(reviewPrompt('review', 'high'), /Run 3 read-only review subagents/);
  const ultra = reviewPrompt('review', 'ultra 12');
  assert.match(ultra, /Run 5 read-only review subagents/);
  assert.match(ultra, /independent verifier subagent/);
  assert.match(ultra, /gh pr diff 12/);
  assert.match(reviewPrompt('review', ''), /Do not modify any files/);
  assert.match(reviewPrompt('review', '--fix'), /fix every confirmed finding/);
  assert.match(reviewPrompt('review', '--comment 7'), /gh pr review 7 --comment/);
  assert.match(reviewPrompt('review', '--max-findings all'), /every confirmed finding/);
  assert.match(reviewPrompt('review', 'src/lib'), /a path/);
  assert.match(reviewPrompt('security-review', ''), /security/);
});

test('/ultrareview routes to the deep review prompt', async () => {
  const ultra = await runBuiltinCommand('ultrareview', '5', { root: process.cwd(), env: process.env });
  assert.match(ultra.prompt, /verifier subagent/);
  assert.match(ultra.output, /pull request #5 \(ultra effort\)/);
});
