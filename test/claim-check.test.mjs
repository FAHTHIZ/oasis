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
