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

test('giving up after a tool error is recognized', async () => {
  const { givesUpEarly } = await import('../src/agent.mjs');
  assert.ok(givesUpEarly('I apologize, but I cannot proceed with the task as requested.'));
  assert.ok(givesUpEarly("I'm unable to complete this because the file is missing."));
  assert.ok(!givesUpEarly('Created src/lib.mjs and npm test passed.'));
});

test('claims of changes that did not happen are recognized', async () => {
  const { claimsUnmadeChange } = await import('../src/agent.mjs');
  assert.ok(claimsUnmadeChange('I have created the `clampInteger` function in `src/lib.mjs`.'));
  assert.ok(claimsUnmadeChange("I've updated the parser."));
  assert.ok(claimsUnmadeChange('The function has been implemented.'));
  assert.ok(!claimsUnmadeChange('The file does not exist yet.'));
});

test('small windows drop non-blocking "language server missing" notes from tool results', async () => {
  const { leanToolContent } = await import('../src/agent.mjs');
  const content = JSON.stringify({ path: 'a.mjs', writtenBytes: 3, lspVerification: { status: 'unavailable', blocking: false, reason: 'No typescript language server found.' } });
  assert.equal(leanToolContent({ config: { contextWindow: 16384 } }, content, {}), JSON.stringify({ path: 'a.mjs', writtenBytes: 3 }));
  assert.equal(leanToolContent({ config: { contextWindow: 200000 } }, content, {}), content);
  const blocking = JSON.stringify({ path: 'a.mjs', lspVerification: { status: 'unavailable', blocking: true } });
  assert.equal(leanToolContent({ config: { contextWindow: 16384 } }, blocking, {}), blocking);
});
