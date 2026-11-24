// Live run (2026-11-24, auto mode): "Run the unit tests ... tell me exactly
// which tests pass or fail. Do not change any files." The model edited
// wordfreq.py four times; workspace edits never reach the classifier, so
// nothing stopped it. A request that rules out file changes now refuses the
// file-editing tools for that request.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';
import { forbidsFileChanges, forbiddenFileChange } from '../src/git-intent.mjs';
import { FILE_EDITING_TOOL_NAMES, asksForAction, asksForReport } from '../src/turn-guards.mjs';

test('requests that rule out file changes are recognized', () => {
  for (const text of [
    'Run the unit tests and tell me which fail. Do not change any files.',
    "Don't touch anything, just look",
    'Review it, make no changes.',
    'do not modify any files',
    'Explain the bug without editing any files',
    'This is a read-only review'
  ]) assert.equal(forbidsFileChanges(text), true, text);
});

test('scoped or narrower limits still allow edits', () => {
  for (const text of [
    'Fix the bug. Do not change any files outside src/',
    'Do not change the files in tests/',
    "Don't modify the README.md",
    "Fix the test, don't change the code",
    "Add a flag; don't edit any files other than cli.js",
    "don't change anything except the docs",
    'Fix it without changing anything else',
    'Do not change files named config',
    'Fix the parser',
    'First, call task_claim for exactly t1 before changing project files. If the claim is denied or the task is no longer ready, do not edit anything; report the blocker.'
  ]) assert.equal(forbidsFileChanges(text), false, text);
});

test('only file-editing tools are refused', () => {
  const ask = 'Tell me which tests fail. Do not change any files.';
  assert.match(forbiddenFileChange(ask, 'edit_file', FILE_EDITING_TOOL_NAMES), /asked you not to change files/);
  assert.match(forbiddenFileChange(ask, 'write_file', FILE_EDITING_TOOL_NAMES), /describe any change/);
  assert.equal(forbiddenFileChange(ask, 'read_file', FILE_EDITING_TOOL_NAMES), null);
  assert.equal(forbiddenFileChange(ask, 'run_command', FILE_EDITING_TOOL_NAMES), null);
  assert.equal(forbiddenFileChange('Fix the parser', 'edit_file', FILE_EDITING_TOOL_NAMES), null);
});

test('an edit in a "do not change any files" turn is refused even when edits are auto-approved', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-noedit-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-noedit-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  await writeFile(path.join(root, 'a.py'), 'x = 1\n');
  const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = ''; for await (const c of req) body += c;
    requests.push(JSON.parse(body));
    const n = requests.length;
    const message = n === 1
      ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'edit_file', arguments: JSON.stringify({ path: 'a.py', old_string: 'x = 1', new_string: 'x = 2' }) } }] }
      : { role: 'assistant', content: 'x is 1; I would change it to 2.' };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message, finish_reason: n === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: 'k', maxSteps: 4 }, env });
  t.after(() => closeSession(session));
  await runAgentTurn(session, 'What is x in a.py? Do not change any files.', { autoApprove: true, env, approval: async () => true });
  assert.equal(await readFile(path.join(root, 'a.py'), 'utf8'), 'x = 1\n', 'the file is unchanged');
  assert.match(JSON.stringify(requests[1].messages), /asked you not to change files/);
});

test('a run-and-report request is not nudged into editing', () => {
  assert.equal(asksForAction('Run the unit tests and tell me which fail. Do not change any files.'), false);
  assert.equal(asksForReport('Run the unit tests with python3 -m unittest discover and tell me exactly which tests pass or fail.'), true);
  assert.equal(asksForReport('Run npm test and show me the output'), true);
  assert.equal(asksForReport('run the tests and fix what fails'), false);
  assert.equal(asksForReport('Fix the parser'), false);
});

// The same live run: the model ran the tests and answered with the output in
// a code block; the "you described the work instead of doing it" nudge then
// told it to edit, and it dropped its report to try a fix.
for (const ask of ['Run the tests with python3 -m unittest discover and tell me which pass or fail.', 'Run the tests with python3 -m unittest discover and tell me which pass or fail. Do not change any files.']) {
  test('a quoted test report is the answer, not a tutorial: ' + ask.slice(-30), async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-report-'));
    const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-report-home-'));
    t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
    await writeFile(path.join(root, 'test_a.py'), 'import unittest\nclass T(unittest.TestCase):\n    def test_ok(self):\n        self.assertTrue(True)\n');
    const env = { ...process.env, HOME: home, OASIS_CONFIG_DIR: path.join(home, 'cfg') };
    const requests = [];
    const server = createServer(async (req, res) => {
      let body = ''; for await (const c of req) body += c;
      requests.push(JSON.parse(body));
      const n = requests.length;
      const message = n === 1
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'python3', args: ['-m', 'unittest', 'discover'] }) } }] }
        : { role: 'assistant', content: 'The run printed:\n\n```\n.\nRan 1 test\nOK\n```\n\ntest_ok passes; nothing fails.' };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message, finish_reason: n === 1 ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const session = await createSession({ root, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'm', apiKey: 'k', maxSteps: 5 }, env });
    t.after(() => closeSession(session));
    const result = await runAgentTurn(session, ask, { autoApprove: true, env, approval: async () => true });
    assert.equal(requests.length, 2, 'no nudge after the report');
    assert.match(result.text, /test_ok passes/);
  });
}
