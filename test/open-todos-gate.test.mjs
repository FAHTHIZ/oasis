import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';
import { createSession, runAgentTurn, closeSession } from '../src/agent.mjs';

async function fixture(t, script) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-todos-gate-'));
  const { config, requests } = await scriptedModel(t, script);
  const session = await createSession({ root, config, permissionMode: 'bypassPermissions', env: { ...process.env, HOME: root, OASIS_CONFIG_DIR: root } });
  t.after(async () => { closeSession(session); await rm(root, { recursive: true, force: true }); });
  return { session, requests };
}

const plan = toolCall('t1', 'todo_write', { todos: [
  { content: 'Write the parser', status: 'completed' },
  { content: 'Add tests for the parser', status: 'in_progress' },
  { content: 'Update the README', status: 'pending' }
] });

test('finishing while the checklist still has open steps is sent back once', async (t) => {
  const { session, requests } = await fixture(t, [plan, { content: 'All done.' }, { content: 'Tests and README are still open; I stopped after the parser.' }]);
  const result = await runAgentTurn(session, 'Plan it in a checklist, then report.', {});
  assert.equal(requests.length, 3);
  const nudge = requests[2].messages.at(-1);
  assert.equal(nudge.role, 'user');
  assert.match(String(nudge.content), /Add tests for the parser/);
  assert.match(String(nudge.content), /Update the README/);
  assert.match(result.text, /still open/);
});

test('a finished checklist does not trigger the reminder', async (t) => {
  const done = toolCall('t2', 'todo_write', { todos: [{ content: 'Write the parser', status: 'completed' }] });
  const { session, requests } = await fixture(t, [done, { content: 'All done.' }]);
  const result = await runAgentTurn(session, 'Plan it in a checklist, then report.', {});
  assert.equal(requests.length, 2);
  assert.equal(result.text, 'All done.');
});

test('a checklist left open by an earlier turn does not hijack an unrelated answer', async (t) => {
  const { session, requests } = await fixture(t, [plan, { content: 'Stopping here for now.' }, { content: 'Noted, parser and README remain.' }, { content: 'It is a parser for CSV files.' }]);
  await runAgentTurn(session, 'Plan it in a checklist, then report.', {});
  const before = requests.length;
  const result = await runAgentTurn(session, 'What is this project?', {});
  assert.equal(requests.length, before + 1);
  assert.equal(result.text, 'It is a parser for CSV files.');
});

// The full review came back once as "All checklist items are now marked complete".
test('a full answer sent back for open steps is kept when the model only ticks them off', async (t) => {
  const review = '**Code review of mathx.py**\n\n| Severity | Issue |\n|---|---|\n| Low | div raises ValueError, not ZeroDivisionError |\n| Low | mul has no type checks |\n\nNo high-risk findings. ' + 'Details follow. '.repeat(10).trim();
  const one = toolCall('t1', 'todo_write', { todos: [{ content: 'Review mathx.py', status: 'pending' }] });
  const tick = toolCall('t2', 'todo_write', { todos: [{ content: 'Review mathx.py', status: 'completed' }] });
  const { session, requests } = await fixture(t, [one, { content: review }, tick, { content: 'All checklist items are now marked complete. No further actions are pending for this task.' }]);
  const result = await runAgentTurn(session, 'Review mathx.py with a checklist.', {});
  assert.equal(requests.length, 4);
  assert.equal(result.text, review);
  assert.equal(session.messages.filter((m) => m.role === 'assistant').at(-1).content, review, 'the transcript keeps the review as the answer');
});

test('work done after the open-steps reminder keeps the new reply', async (t) => {
  const review = 'Partial answer that claims the review is done. '.repeat(8);
  const one = toolCall('t1', 'todo_write', { todos: [{ content: 'Write notes.txt', status: 'pending' }] });
  const write = toolCall('t2', 'write_file', { path: 'notes.txt', content: 'hi\n' });
  const tick = toolCall('t3', 'todo_write', { todos: [{ content: 'Write notes.txt', status: 'completed' }] });
  const { session } = await fixture(t, [one, { content: review }, write, tick, { content: 'Wrote notes.txt.' }]);
  const result = await runAgentTurn(session, 'Plan it in a checklist, then write notes.txt.', {});
  assert.match(result.text, /Wrote notes\.txt/);
});
