// The main-turn task contract (src/task-model.mjs, src/completion-gates.mjs):
// a final answer is held to what the request asked for, checked against the
// turn's tool results, with one bounded nudge and an honest notice after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

async function workspace(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-task-gate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

const env = { ...process.env, OASIS_AGENT_EXPERIENCE: '0', OASIS_NEURON_LEDGER: '0' };
const lastUser = (payload) => [...payload.messages].reverse().find((message) => message.role === 'user');

async function run(t, script, prompt, extraEnv = {}) {
  const root = await workspace(t);
  const { config, requests } = await scriptedModel(t, script);
  const session = await createSession({ root, config, settings: { permissions: { allow: [], ask: [], deny: [] } }, bare: true });
  const result = await runAgentTurn(session, prompt, { autoApprove: true, approval: async () => true, env: { ...env, ...extraEnv } });
  return { root, session, result, requests };
}

const WORDS = (n) => Array.from({ length: n }, (_, i) => 'word' + i).join(' ');

test('a missing deliverable file is sent back once, then the turn finishes verified', async (t) => {
  const { root, result, requests } = await run(t, [
    { content: 'Here is the summary: ' + WORDS(50) },
    toolCall('w1', 'write_file', { path: 'summary.md', content: WORDS(100) }),
    { content: 'I wrote the summary to summary.md.' }
  ], 'Write a 100-word summary of the project goals to summary.md.');
  assert.match(String(lastUser(requests[1]).content), /summary\.md does not exist/);
  assert.equal((await readFile(path.join(root, 'summary.md'), 'utf8')).split(' ').length, 100);
  assert.equal(result.task.outcome.verdict, 'verified', JSON.stringify(result.task.outcome));
  assert.doesNotMatch(result.text, /Not verified/);
  assert.equal(requests.length, 3);
});

test('what is still unmet after the nudge is named to the user, not reported as done', async (t) => {
  const { result, requests } = await run(t, [
    { content: 'Done, the report is in report.md.' },
    { content: 'Done, the report is in report.md.' }
  ], 'Write the incident report to report.md.');
  assert.equal(requests.length, 2, 'one nudge, no loop');
  assert.match(result.text, /Not verified: report\.md does not exist/);
  assert.equal(result.task.outcome.verdict, 'rejected');
  assert.equal(result.task.outcome.acceptance.unmet, 1);
});

test('a main-turn answer citing a page it never fetched is held to the research contract', async (t) => {
  // Regression: report contracts used to apply only to subagents and
  // workflows, so the main agent could cite unread pages unchecked.
  const { result, requests } = await run(t, [
    { content: 'According to https://example.invalid/battery-study the cells last 20 years.' },
    { content: 'I could not read a source for this, so I cannot confirm how long the cells last.' }
  ], 'Research how long solid-state battery cells last and cite your sources.');
  assert.match(String(lastUser(requests[1]).content), /never fetched/);
  assert.equal(requests.length, 2);
  assert.notEqual(result.task.outcome.verdict, 'verified');
  assert.doesNotMatch(result.text, /Not verified: .*never fetched/, 'the corrected answer cites nothing unread');
});

test('a length limit on the reply is checked', async (t) => {
  const { result, requests } = await run(t, [
    { content: WORDS(80) },
    { content: WORDS(40) }
  ], 'Write a product description, under 50 words.');
  assert.match(String(lastUser(requests[1]).content), /has 80 words, more than 50/);
  assert.equal(result.task.outcome.verdict, 'verified');
});

test('simple questions get no contract text and no extra round trip', async (t) => {
  const { result, requests } = await run(t, [{ content: 'A monad is a design pattern.' }], 'What is a monad?');
  assert.equal(requests.length, 1);
  assert.doesNotMatch(String(lastUser(requests[0]).content), /task-contract/);
  assert.equal(result.task.outcome.verdict, 'unverified', 'nothing was checked, and the outcome says so');
});

test('task_contract shows the contract and refuses to let the model mark criteria met', async (t) => {
  const { result, requests } = await run(t, [
    toolCall('c1', 'task_contract', { action: 'declare', acceptance: [{ kind: 'file_exists', description: 'notes exist', path: 'notes.md' }, { kind: 'file_exists', description: 'escape', path: '../x.md' }] }),
    toolCall('c2', 'task_contract', { action: 'status' }),
    { content: 'Notes are not written yet; I stopped here.' },
    { content: 'Notes are not written yet; I stopped here.' }
  ], 'Draft meeting notes for the planning session and save them as notes.md.');
  const declared = JSON.parse(requests[1].messages.at(-1).content);
  assert.ok(declared.errors.some((error) => /inside the workspace/.test(error)));
  const status = JSON.parse(requests[2].messages.at(-1).content);
  assert.ok(status.criteria.every((item) => item.status !== 'met'));
  assert.match(result.text, /Not verified/);
});

test('OASIS_TASK_MODEL=0 turns the contract off', async (t) => {
  const { result, requests } = await run(t, [{ content: 'Done, the report is in report.md.' }], 'Write the incident report to report.md.', { OASIS_TASK_MODEL: '0' });
  assert.equal(requests.length, 1);
  assert.equal(result.task, undefined);
});
