import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationIssues, diffReviewComplete } from '../src/agent.mjs';

const base = (over = {}) => ({ changedPaths: new Set(), diffReviewedPaths: new Set(), diffReviewedAll: false, lastVerificationExitCode: 0, lastVerificationKind: 'test', lspVerificationByPath: new Map(), ...over });

test('a file created this turn needs no separate diff review once checks pass', () => {
  const state = base({ changedPaths: new Set(['src/lib.mjs']), createdPaths: new Set(['src/lib.mjs']) });
  assert.equal(diffReviewComplete(state), true);
  assert.deepEqual(verificationIssues(state), []);
});

test('an edited existing file still needs a diff review', () => {
  const state = base({ changedPaths: new Set(['src/lib.mjs', 'src/app.mjs']), createdPaths: new Set(['src/lib.mjs']) });
  assert.equal(diffReviewComplete(state), false);
  assert.deepEqual(verificationIssues(state), ['the changed-file diff has not been reviewed']);
  state.diffReviewedPaths.add('src/app.mjs');
  assert.deepEqual(verificationIssues(state), []);
});

test('a created source file still needs a passing check', () => {
  const state = base({ changedPaths: new Set(['src/lib.mjs']), createdPaths: new Set(['src/lib.mjs']), lastVerificationExitCode: null, lastVerificationKind: null });
  assert.deepEqual(verificationIssues(state), ['no relevant test, check, lint, build, or type-check command has passed after the latest code edit']);
});

test('the gate asks to exercise a new module directly when no test changed', async () => {
  const { untestedNewCode } = await import('../src/agent.mjs');
  assert.match(untestedNewCode({ changedPaths: new Set(['src/lib.mjs']), createdPaths: new Set(['src/lib.mjs']) })[0], /^New code in src\/lib\.mjs is not exercised/);
  assert.deepEqual(untestedNewCode({ changedPaths: new Set(['src/lib.mjs', 'test/lib.test.mjs']), createdPaths: new Set(['src/lib.mjs']) }), []);
  assert.deepEqual(untestedNewCode({ changedPaths: new Set(['notes.md']), createdPaths: new Set(['notes.md']) }), []);
  assert.deepEqual(untestedNewCode({ changedPaths: new Set(['src/a.mjs']) }), []);
});
