import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { claimsPassing, newClaimState, recordCheck, recordEdit, claimIssue } from '../src/claim-check.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';

test('detects success claims and ignores honest failure reports', () => {
  for (const text of ['All tests pass now.', 'The test suite is green.', 'Build succeeded and tests are passing.', 'all 42 tests pass', '12 passed, 0 failed', '✅ Tests']) assert.ok(claimsPassing(text), text);
  for (const text of ['Two tests still fail.', 'The tests do not pass yet.', 'I could not run the tests.', 'I updated the README.', '']) assert.ok(!claimsPassing(text), text);
});

test('claimIssue flags failed, piped and stale checks once', () => {
  const failed = newClaimState();
  recordCheck(failed, { command: 'npm test', exitCode: 1 });
  assert.match(claimIssue(failed, 'All tests pass.'), /exited with code 1/);
  assert.equal(claimIssue(failed, 'All tests pass.'), '', 'only one nudge per turn');
  const piped = newClaimState();
  recordCheck(piped, { command: 'npm test | tail', exitCode: 0, masked: true });
  assert.match(claimIssue(piped, 'Tests pass.'), /hidden by a pipe/);
  const stale = newClaimState();
  recordCheck(stale, { command: 'npm test', exitCode: 0 });
  recordEdit(stale);
  assert.match(claimIssue(stale, 'Tests pass.'), /stale/);
  const good = newClaimState();
  recordCheck(good, { command: 'npm test', exitCode: 0 });
  assert.equal(claimIssue(good, 'All tests pass.'), '');
  assert.equal(claimIssue(newClaimState(), 'All tests pass.'), '', 'no check this turn: nothing to contradict');
});

test('agent claiming success after a failing test run is asked to reconcile', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-claim-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', scripts: { test: 'node -e "process.exit(3)"' } }));
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    const n = payloads.length;
    const message = n === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'npm', args: ['test'] }) } }] }
      : n === 2 ? { role: 'assistant', content: 'Done. All tests pass.' }
      : { role: 'assistant', content: 'Correction: the test fails with "boom".' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 6 } });
  const result = await runAgentTurn(session, 'run the tests', { autoApprove: true });
  assert.equal(payloads.length, 3);
  const nudge = payloads[2].messages[payloads[2].messages.length - 1];
  assert.equal(nudge.role, 'user');
  assert.match(nudge.content, /says the checks pass, but the latest check \(`npm test`\) exited with code 3/);
  assert.match(result.text, /test fails/);
});

test('a check that timed out or was stopped does not support a success claim', () => {
  const state = newClaimState();
  recordCheck(state, { command: 'npm test', exitCode: 0 });
  assert.equal(claimIssue(state, 'All tests pass.'), '');
  // Re-run without edits, but this time it hangs and is killed: no exit code.
  recordCheck(state, { command: 'npm test', exitCode: null });
  assert.match(claimIssue(state, 'All tests pass.'), /did not finish/);
});

test('claimIssue: edited code, no check ran, reply claims passing tests', () => {
  const state = newClaimState();
  assert.match(claimIssue(state, 'All tests now pass.', { edited: true, deniedCheck: 'npm test' }), /no test, check or build command ran.*`npm test` was not approved/);
  assert.equal(claimIssue(state, 'All tests now pass.', { edited: true }), '', 'still only one nudge per turn');
  assert.equal(claimIssue(newClaimState(), 'All tests pass.', { edited: false }), '', 'nothing edited: nothing to contradict');
});

test('appendUnverifiedNotice says plainly what was not checked', async () => {
  const { appendUnverifiedNotice } = await import('../src/claim-check.mjs');
  const issue = ['no relevant test, check, lint, build, or type-check command has passed after the latest code edit'];
  const denied = appendUnverifiedNotice('Fixed it. All tests now pass.', issue, { deniedCheck: 'npm test' }, newClaimState());
  assert.match(denied, /Not verified: `npm test` was not approved, so no check ran\. Any passing test results described above were not observed by OASIS\. Run `npm test` to confirm\.$/);
  const failed = newClaimState();
  recordCheck(failed, { command: 'npm test', exitCode: 1 });
  assert.match(appendUnverifiedNotice('Fixed.', issue, {}, failed), /Not verified: the last check \(`npm test`\) failed with exit code 1\.$/);
  assert.equal(appendUnverifiedNotice('Fixed.', ['the changed-file diff has not been reviewed (a.js)'], {}, newClaimState()), 'Fixed.', 'diff review alone adds no note');
  assert.equal(appendUnverifiedNotice(denied, issue, { deniedCheck: 'npm test' }, newClaimState()), denied, 'never added twice');
});

// Real run, 9 Nov 2026 (gpt-oss-20b, oasis -p --permission-mode accept-edits):
// npm test was not approved, the gate asked for a passing check, and the model
// answered with an invented "All tests passed (3)" log that went to the user.
test('a denied test command never ends in an unqualified "tests pass" answer', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-claim-denied-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', type: 'module', scripts: { test: 'node --test' } }));
  await writeFile(path.join(root, 'cart.mjs'), 'export const add = (a, b) => a - b;\n');
  const payloads = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    payloads.push(JSON.parse(body));
    const n = payloads.length;
    const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
    const message = n === 1 ? call('c1', 'edit_file', { path: 'cart.mjs', old_string: 'a - b', new_string: 'a + b' })
      : n === 2 ? call('c2', 'run_command', { command: 'npm', args: ['test'] })
      : n === 3 ? { role: 'assistant', content: 'Fixed add(). Run npm test to confirm.' }
      : n === 4 ? { role: 'assistant', content: 'Verification:\n```\nPASS cart.test.mjs\nAll tests passed (3)\n```\nAll tests now pass.' }
      : { role: 'assistant', content: 'Fixed add() in cart.mjs. The tests were not run because npm test was not approved; run npm test to confirm.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 10 } });
  const result = await runAgentTurn(session, 'fix add() in cart.mjs and run npm test', { permissionMode: 'acceptEdits', approval: async () => false, env: { ...process.env, OASIS_ASSISTED_VERIFICATION: '0' } });
  const gate = payloads[3].messages[payloads[3].messages.length - 1].content;
  assert.match(gate, /`npm test` was not approved, so it cannot run in this session/);
  assert.match(gate, /never write test or command output you did not see/);
  const claimNudge = payloads[4].messages[payloads[4].messages.length - 1].content;
  assert.match(claimNudge, /no test, check or build command ran in this turn \(`npm test` was not approved/);
  assert.doesNotMatch(result.text, /All tests passed/);
  // The final answer admits the check did not run, so no duplicate notice is added.
  assert.match(result.text, /tests were not run because npm test was not approved/);
  assert.doesNotMatch(result.text, /Not verified: /);
  assert.equal(result.verificationIncomplete, true);
});

test('appendUnverifiedNotice does not repeat an honest admission', async () => {
  const { appendUnverifiedNotice } = await import('../src/claim-check.mjs');
  const issues = ['no relevant test, check, lint, build, or type-check command has passed'];
  const state = { ran: false, changedPaths: new Set() };
  const honest = 'Fixed. `npm test` was not approved, so run it yourself.';
  assert.equal(appendUnverifiedNotice(honest, issues, { deniedCheck: 'npm test' }, state), honest);
  assert.match(appendUnverifiedNotice('Fixed. All tests pass.', issues, { deniedCheck: 'npm test' }, state), /Not verified: .*were not observed by OASIS/);
});
