import test from 'node:test';
import assert from 'node:assert/strict';
import { asksForAction, readsLikeInstructions, announcesNextStep } from '../src/agent.mjs';

test('change requests are told apart from questions', () => {
  for (const request of ['Create src/lib.mjs exporting clampInteger', 'fix the failing test', 'please add a --json flag', 'Can you refactor the parser']) assert.ok(asksForAction(request), request);
  for (const request of ['how do I add a flag?', 'explain the parser', 'review this diff', 'what does createSession do']) assert.ok(!asksForAction(request), request);
});

test('tutorial-style replies and announced-but-unexecuted steps are recognized', () => {
  assert.ok(readsLikeInstructions('To solve this:\n1. Define the function.\n2. Export it.'));
  assert.ok(readsLikeInstructions('You can add this to src/lib.mjs:\n```js\nexport function f() {}\n```'));
  assert.ok(!readsLikeInstructions('Created src/lib.mjs and the tests pass.'));
  assert.ok(announcesNextStep('The file does not exist. I need to create this function and then add it to the file.'));
  assert.ok(announcesNextStep('Let me fix that:'));
  assert.ok(!announcesNextStep('Created src/lib.mjs; npm test passed.'));
});
