import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { unsupportedChildClaim } from '../src/claim-check.mjs';

test('unsupportedChildClaim compares a passing claim with the recorded checks', () => {
  const claim = 'Done. All tests pass.';
  assert.equal(unsupportedChildClaim({ text: 'I read the files; nothing to change.' }), '');
  assert.match(unsupportedChildClaim({ text: claim, verification: { lastCheck: null } }), /ran no test/);
  assert.match(unsupportedChildClaim({ text: claim, verification: { lastCheck: { kind: 'test', exitCode: 1, passed: false } } }), /last test command exited with code 1/);
  assert.match(unsupportedChildClaim({ text: claim, verification: { lastCheck: { kind: 'test', exitCode: 0, passed: true } }, verificationIssues: ['no relevant test, check, lint, build, or type-check command has passed after the latest code edit'] }), /edited files after its last passing check/);
  assert.equal(unsupportedChildClaim({ text: claim, verification: { lastCheck: { kind: 'test', exitCode: 0, passed: true } }, verificationIssues: [] }), '');
});

// The parent asks one subagent to run the tests. The child's scripted replies
// decide what it runs and what it reports; the test reads the task result the
// parent receives.
async function delegate(t, childScript) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-child-claim-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, '.config-oasis');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(root, 'pass.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  await writeFile(path.join(root, 'fail.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert';\ntest('bad', () => { assert.equal(1, 2); });\n");
  let taskResult = null;
  let childStep = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    let message;
    if (/SUBAGENT MODE/.test(String(payload.messages[0].content))) {
      message = childScript[Math.min(childStep++, childScript.length - 1)];
    } else {
      const tool = payload.messages.find((m) => m.role === 'tool');
      if (tool) { taskResult = JSON.parse(tool.content); message = { role: 'assistant', content: 'done' }; }
      else message = { role: 'assistant', content: null, tool_calls: [{ id: 'p1', type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'run tests', prompt: 'Run the tests and report.', subagent_type: 'general-purpose' }) } }] };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SUBAGENT_EFFORT: '', CLAUDE_CODE_SUBAGENT_EFFORT: '' };
  // Inside `node --test`, a nested `node --test` reports to this runner
  // instead of exiting with its own status.
  delete env.NODE_TEST_CONTEXT;
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6 } });
  await runAgentTurn(session, 'go', { autoApprove: true, env });
  assert.ok(taskResult, 'the parent received the task result');
  return taskResult;
}

const runTest = (file) => ({ role: 'assistant', content: null, tool_calls: [{ id: 'r' + file, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node', args: ['--test', file] }) } }] });
const claim = { role: 'assistant', content: 'All tests pass.' };

test('a child that claims passing tests without running any is flagged to the parent', async (t) => {
  const result = await delegate(t, [claim]);
  assert.match(result.unverified_claim, /ran no test, check, lint or build command/);
  assert.match(result.note_on_report, /did not observe a passing check/);
});

test('a child whose last test run failed cannot report a pass to the parent', async (t) => {
  const result = await delegate(t, [runTest('fail.test.mjs'), claim, claim]);
  assert.match(result.unverified_claim, /exited with code 1/);
});

test('a child that ran passing tests reports without a flag', async (t) => {
  const result = await delegate(t, [runTest('pass.test.mjs'), claim]);
  assert.equal(result.unverified_claim, undefined);
  assert.match(result.report, /All tests pass/);
});
