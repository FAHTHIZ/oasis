import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { assertLearningOutcome, createSkillProposal, describeTaskCheck, learningProposalText, getSkillProposal } from '../src/learning.mjs';
import { provisionalTaskOutcome } from '../src/completion-gates.mjs';
import { deriveTaskSpec } from '../src/task-model.mjs';

const BODY = ['Purpose', 'Inputs', 'Workflow', 'Required provider capabilities', 'Permissions', 'Success criteria']
  .map((heading) => '## ' + heading + '\nRead the quarterly sales CSV, skip malformed rows, compute totals by region and state the same numbers in the written summary for the reader.').join('\n\n');

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-learning-check-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-learning-check-home-'));
  t.after(async () => { await rm(root, { recursive: true, force: true }); await rm(home, { recursive: true, force: true }); });
  return { root, env: { ...process.env, HOME: home, USERPROFILE: home, OASIS_CONFIG_DIR: path.join(home, '.oasis'), XDG_CONFIG_HOME: path.join(home, '.config') } };
}

test('a task that has not succeeded cannot teach a skill', () => {
  assert.throws(() => assertLearningOutcome({ verdict: 'rejected', unmet: ['Write report/summary.md'] }), /has not succeeded \(unmet: Write report\/summary\.md\)/);
  assert.throws(() => assertLearningOutcome({ verdict: 'rejected', unmet: [], review: 'fail' }), /an independent review failed/);
  assert.throws(() => assertLearningOutcome({ verdict: 'failed' }), /the task is failed/);
  assert.equal(assertLearningOutcome({ verdict: 'unverified' }), true);
  assert.equal(assertLearningOutcome({ verdict: 'verified', met: 2, total: 2 }), true);
  assert.equal(assertLearningOutcome(null), true, 'no task model, no extra gate');
});

test('the task check is described for whoever reviews the proposal', () => {
  assert.equal(describeTaskCheck({ verdict: 'verified', met: 2, total: 2 }), 'verified (2 of 2 criteria met)');
  assert.equal(describeTaskCheck({ verdict: 'independently_verified', met: 1, total: 1 }), 'independently verified (1 of 1 criteria met)');
  assert.match(describeTaskCheck({ verdict: 'evidenced' }), /not fully checked/);
  assert.match(describeTaskCheck({ verdict: 'unverified' }), /^unchecked/);
  assert.equal(describeTaskCheck(null), '');
});

test('the runtime check, not the model, is stored on the proposal', async (t) => {
  const { root, env } = await fixture(t);
  const session = { sessionId: 's1', pendingLearningCheck: { verdict: 'verified', met: 3, total: 3 } };
  const made = await createSkillProposal(root, { name: 'sales-region-summary', description: 'Summarize sales by region from a CSV.', body: BODY, evidence: 'report/summary.json matched the recomputed totals.', taskCheck: { verdict: 'independently_verified' } }, { env, session });
  assert.deepEqual(made.taskCheck, { verdict: 'verified', met: 3, total: 3 });
  assert.equal(session.pendingLearningCheck, undefined, 'used once');
  const stored = await getSkillProposal(root, made.id, { env });
  assert.match(learningProposalText(stored), /Task check: verified \(3 of 3 criteria met\)/);
  const unchecked = await createSkillProposal(root, { name: 'other-summary', description: 'Another summary procedure.', body: BODY, evidence: 'The summary was written and read back.' }, { env, session: { sessionId: 's2' } });
  assert.equal(unchecked.taskCheck, undefined);
});

test('the provisional outcome rejects a task whose deliverable was never written', async (t) => {
  const { root, env } = await fixture(t);
  const task = deriveTaskSpec('Write report/summary.md with the revenue by region from data/sales.csv.');
  const session = { root, task, messages: [], evidence: [] };
  const before = provisionalTaskOutcome(session, { env });
  assert.ok(before, 'a task gives a provisional outcome');
  assert.equal(before.verdict, 'rejected', JSON.stringify(before));
  assert.throws(() => assertLearningOutcome(before), /has not succeeded/);
  assert.equal(provisionalTaskOutcome({ root, messages: [] }, { env }), null);
  assert.equal(provisionalTaskOutcome(session, { env: { ...env, OASIS_TASK_MODEL: '0' } }), null);
});

test('in a turn, skill_propose is refused until the task deliverable exists, then carries the check', async (t) => {
  const { createServer } = await import('node:http');
  const { mkdir, writeFile, readdir } = await import('node:fs/promises');
  const { createSession, runAgentTurn } = await import('../src/agent.mjs');
  const { root, env: base } = await fixture(t);
  await mkdir(path.join(root, 'data'), { recursive: true });
  await writeFile(path.join(root, 'data', 'sales.csv'), 'region,amount\nnorth,5\nsouth,7\n');
  const propose = (id) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name: 'skill_propose', arguments: JSON.stringify({ name: 'region-notes', description: 'Write region notes from the sales CSV.', body: BODY, evidence: 'notes.md written from data/sales.csv and read back.' }) } }] });
  const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const script = [
    propose('p1'),
    call('w1', 'write_file', { path: 'notes.md', content: 'north 5, south 7\n' }),
    propose('p2'),
    { role: 'assistant', content: 'Wrote notes.md (north 5, south 7) and proposed the procedure as a skill.' }
  ];
  const results = {};
  let step = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    for (const m of payload.messages) if (m.role === 'tool') results[m.tool_call_id] = m.content;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: script[Math.min(step++, script.length - 1)] }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...base };
  delete env.NODE_TEST_CONTEXT;
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 8 } });
  await runAgentTurn(session, 'Write notes.md with the amount for each region in data/sales.csv.', { autoApprove: true, env });
  assert.match(String(results.p1), /has not succeeded/, 'refused before notes.md existed: ' + results.p1);
  const second = JSON.parse(String(results.p2));
  assert.ok(second.id, 'accepted after the deliverable was written: ' + results.p2);
  assert.ok(second.taskCheck && second.taskCheck.verdict, 'the proposal carries the runtime check');
  assert.notEqual(second.taskCheck.verdict, 'rejected');
  const dirs = await readdir(path.join(env.OASIS_CONFIG_DIR, 'learning', 'projects'));
  assert.equal(dirs.length, 1);
});
