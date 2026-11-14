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
  assert.ok(claimsUnmadeChange('The function `sum` in math.mjs is fixed to return a + b.'));
  assert.ok(claimsUnmadeChange('The file was updated successfully.'));
  assert.ok(claimsUnmadeChange('math.mjs is now corrected.'));
  assert.ok(!claimsUnmadeChange('The bug is fixed once add returns a + b.'));
  assert.ok(!claimsUnmadeChange('The function will be updated after I read the file.'));
  assert.ok(!claimsUnmadeChange('I will check which line needs to change.'));
  assert.ok(!claimsUnmadeChange('add in math.mjs is already fixed: it returns a + b.'));
});

test('small windows drop non-blocking "language server missing" notes from tool results', async () => {
  const { leanToolContent } = await import('../src/agent.mjs');
  const content = JSON.stringify({ path: 'a.mjs', writtenBytes: 3, lspVerification: { status: 'unavailable', blocking: false, reason: 'No typescript language server found.' } });
  assert.equal(leanToolContent({ config: { contextWindow: 16384 } }, content, {}), JSON.stringify({ path: 'a.mjs', writtenBytes: 3 }));
  assert.equal(leanToolContent({ config: { contextWindow: 200000 } }, content, {}), content);
  const blocking = JSON.stringify({ path: 'a.mjs', lspVerification: { status: 'unavailable', blocking: true } });
  assert.equal(leanToolContent({ config: { contextWindow: 16384 } }, blocking, {}), blocking);
});

test('canned refusals are recognized, reasoned ones are not', async () => {
  const { refusesSpuriously } = await import('../src/agent.mjs');
  assert.ok(refusesSpuriously("I'm sorry, but I can't assist with that."));
  assert.ok(refusesSpuriously('I cannot help with this request.'));
  assert.ok(!refusesSpuriously("I can't help with that because it would exfiltrate credentials."));
  assert.ok(!refusesSpuriously('Created src/lib.mjs; tests pass.'));
});

test('false claims with "made the change" wording and target-file hints', async () => {
  const { claimsUnmadeChange, targetFileHint } = await import('../src/agent.mjs');
  assert.ok(claimsUnmadeChange('I have made the change to `src/lib.mjs` by adding the `clampInteger` function.'));
  assert.ok(!claimsUnmadeChange('I made a plan.'));
  assert.ok(!claimsUnmadeChange('I have created a new task to implement the `clampInteger` function.'));
  assert.ok(!claimsUnmadeChange('I have added a todo list.'));
  assert.match(targetFileHint('Create src/lib.mjs exporting clampInteger(...)'), /src\/lib\.mjs/);
  assert.match(targetFileHint('fix the bug in `app/main.py`.'), /app\/main\.py/);
  assert.equal(targetFileHint('make the tests pass'), '');
});

test('fencedFileFromReply picks the largest block in the target language', async () => {
  const { fencedFileFromReply } = await import('../src/agent.mjs');
  const reply = 'Steps:\n```bash\nnpm test\nnpm run x\n```\n```javascript\nexport function clampInteger(v) {\n  return v;\n}\n```';
  assert.deepEqual(fencedFileFromReply('Create src/lib.mjs exporting clampInteger', reply), { path: 'src/lib.mjs', content: 'export function clampInteger(v) {\n  return v;\n}\n' });
  assert.equal(fencedFileFromReply('make tests pass', reply), null);
  assert.equal(fencedFileFromReply('Create app.py', reply), null);
});

test('fencedFileFromReply ignores pseudo-code that calls agent tools', async () => {
  const { fencedFileFromReply } = await import('../src/agent.mjs');
  const reply = '```javascript\nconst existing = read_file(\'src/lib.mjs\');\nwrite_file(\'src/lib.mjs\', existing);\n```';
  assert.equal(fencedFileFromReply('Create src/lib.mjs', reply), null);
});

test('fencedFileFromReply never writes JSON tool calls into a file', async () => {
  const { fencedFileFromReply } = await import('../src/agent.mjs');
  const reply = '```\n{"name": "read_file", "arguments": {"path": "src/lib.mjs"}}\n{"name": "edit_file", "arguments": {"path": "src/lib.mjs"}}\n```';
  assert.equal(fencedFileFromReply('Create src/lib.mjs', reply), null);
});
