// Independent reviews (src/task-reviews.mjs): a separate reviewer's verdict,
// read from its report, counts toward the task outcome only while it reviews
// the files as they are.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { combinedReview, currentReviews, recordTaskReview, reviewVerdict } from '../src/task-reviews.mjs';
import { recordEvidence, sessionEvidence } from '../src/evidence-ledger.mjs';
import { assessOutcome, deriveTaskSpec } from '../src/task-model.mjs';
import { closeExperienceStores, openExperienceStore } from '../src/agent-experience.mjs';
import { noteTaskWorker } from '../src/task-reviews.mjs';

test('a verdict is read from the report and the review itself', () => {
  assert.equal(reviewVerdict('Checked src/a.js and its tests.\nVERDICT: PASS', { toolCalls: 3 }).verdict, 'pass');
  assert.equal(reviewVerdict('I found no actionable defects in the parser.', { toolCalls: 2 }).verdict, 'pass');
  assert.equal(reviewVerdict('1. High: off-by-one in src/a.js:12 drops the last item.\nVERDICT: FAIL', { toolCalls: 2 }).verdict, 'fail');
  assert.equal(reviewVerdict('- **Critical**: the token is logged in src/log.js:40.', { toolCalls: 2 }).verdict, 'fail', 'a severe finding fails without a verdict line');
  assert.match(reviewVerdict('VERDICT: PASS', { toolCalls: 0 }).reason, /without inspecting/);
  assert.equal(reviewVerdict('VERDICT: PASS', { toolCalls: 0 }).verdict, 'inconclusive');
  assert.equal(reviewVerdict('Looked at a.js. VERDICT: PASS', { toolCalls: 4, limitReached: true }).verdict, 'inconclusive', 'a review cut off at a limit does not pass');
  assert.equal(reviewVerdict('High: race in cache.js:9.\nVERDICT: PASS', { toolCalls: 4 }).verdict, 'inconclusive', 'a pass that names a severe finding is not a pass');
  assert.equal(reviewVerdict('I read the files.', { toolCalls: 4 }).verdict, 'inconclusive');
  assert.equal(reviewVerdict('').verdict, 'inconclusive');
});

test('a review stops counting once the files change, and only for its task', () => {
  const session = { task: deriveTaskSpec('Fix the parser bug and have it reviewed.') };
  const ledger = sessionEvidence(session);
  recordEvidence(ledger, { kind: 'edit', tool: 'edit_file', path: 'a.js' });
  recordTaskReview(session, { by: 'code-review', text: 'Checked a.js.\nVERDICT: PASS', toolCalls: 2 });
  assert.equal(currentReviews(session).current.length, 1);
  recordEvidence(ledger, { kind: 'edit', tool: 'edit_file', path: 'a.js' });
  const after = currentReviews(session);
  assert.equal(after.current.length, 0);
  assert.equal(after.stale.length, 1);
  session.task = deriveTaskSpec('Write the release notes.');
  assert.equal(currentReviews(session).stale.length, 0, 'a review of another task is not counted at all');
});

test('reviews combine: any fail fails, an inconclusive review neither passes nor rejects', () => {
  assert.equal(combinedReview([{ verdict: 'pass', by: 'a' }, { verdict: 'fail', by: 'b' }]).verdict, 'fail');
  assert.equal(combinedReview([{ verdict: 'inconclusive', by: 'a' }, { verdict: 'pass', by: 'b' }]).verdict, 'pass');
  const spec = deriveTaskSpec('Fix the parser bug, make sure the tests pass and have it independently reviewed.');
  const events = [{ seq: 1, kind: 'edit', path: 'a.js' }, { seq: 2, kind: 'check', command: 'npm test', finished: true, passed: true, exitCode: 0 }];
  const unsure = assessOutcome(spec, { events, reply: 'Fixed; tests pass.', reviews: [{ by: 'code-review', verdict: 'inconclusive', detail: 'stopped at a limit' }] });
  assert.notEqual(unsure.verdict, 'rejected');
  assert.notEqual(unsure.verdict, 'independently_verified');
  const criterion = unsure.acceptance.criteria.find((item) => item.kind === 'independent_review');
  if (criterion) assert.equal(criterion.status, 'unknown');
  assert.equal(assessOutcome(spec, { events, reply: 'Fixed; tests pass.', reviews: [], staleReviews: 1 }).independent.stale, 1);
});

// The parent edits a file, runs its test, then asks the built-in code-review
// agent to review. The reviewer reads the file and passes it; the turn's task
// outcome is independently verified. A parent edit after the review voids it.
async function reviewedTurn(t, { editAfterReview = false, reviewerReply }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-task-review-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const configDir = path.join(root, '.config-oasis');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(root, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  await writeFile(path.join(root, 'sum.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { sum } from './sum.mjs';\ntest('sum', () => assert.equal(sum(2, 3), 5));\n");
  const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const parentScript = [
    call('p0', 'read_file', { path: 'sum.mjs' }),
    call('p1', 'write_file', { path: 'sum.mjs', content: 'export const sum = (a, b) => a + b;\n' }),
    call('p2', 'run_command', { command: 'node', args: ['--test', 'sum.test.mjs'] }),
    call('p3', 'task', { description: 'review the fix', prompt: 'Review the change to sum.mjs.', subagent_type: 'code-review' }),
    ...(editAfterReview ? [call('p4', 'write_file', { path: 'sum.mjs', content: 'export const sum = (a, b) => b + a;\n' }), call('p5', 'run_command', { command: 'node', args: ['--test', 'sum.test.mjs'] })] : []),
    { role: 'assistant', content: 'Fixed sum.mjs; the test passes.' }
  ];
  const childScript = [call('c1', 'read_file', { path: 'sum.mjs' }), { role: 'assistant', content: reviewerReply }];
  let parentStep = 0;
  let childStep = 0;
  let taskResult = null;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    let message;
    if (/SUBAGENT MODE/.test(String(payload.messages[0].content))) message = childScript[Math.min(childStep++, childScript.length - 1)];
    else {
      const tool = payload.messages.filter((m) => m.role === 'tool').find((m) => m.tool_call_id === 'p3');
      if (tool && !taskResult) taskResult = JSON.parse(tool.content);
      message = parentScript[Math.min(parentStep++, parentScript.length - 1)];
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SUBAGENT_EFFORT: '', CLAUDE_CODE_SUBAGENT_EFFORT: '' };
  delete env.NODE_TEST_CONTEXT;
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 10 } });
  const result = await runAgentTurn(session, 'Fix the bug in sum.mjs so the test passes, and have the fix independently reviewed.', { autoApprove: true, env });
  return { session, result, taskResult };
}

test('a passing built-in review of the current files makes the task independently verified', async (t) => {
  const { session, result, taskResult } = await reviewedTurn(t, { reviewerReply: 'Read sum.mjs: the operator is now +, matching the test.\nVERDICT: PASS' });
  assert.equal(taskResult.review_verdict, 'pass');
  assert.equal(session.taskReviews.length, 1);
  const outcome = (result.task && result.task.outcome) || (session.task && session.task.outcome);
  assert.ok(outcome, 'the turn carries the task outcome');
  assert.equal(outcome.independent.passed, true);
  assert.equal(outcome.verdict, 'independently_verified');
});

test('an edit after the review leaves the task without an independent review', async (t) => {
  const { session, result } = await reviewedTurn(t, { editAfterReview: true, reviewerReply: 'Read sum.mjs.\nVERDICT: PASS' });
  const outcome = (result.task && result.task.outcome) || (session.task && session.task.outcome);
  assert.equal(outcome.independent.passed, false);
  assert.equal(outcome.independent.stale, 1);
  assert.notEqual(outcome.verdict, 'independently_verified');
});

test('a failing review rejects the outcome even though the tests passed', async (t) => {
  const { session, result, taskResult } = await reviewedTurn(t, { reviewerReply: '1. High: sum.mjs:1 overflows for large inputs.\nVERDICT: FAIL' });
  assert.equal(taskResult.review_verdict, 'fail');
  const outcome = (result.task && result.task.outcome) || (session.task && session.task.outcome);
  assert.equal(outcome.verdict, 'rejected');
  assert.equal(outcome.execution, 'completed');
});

test('a worker that changed the files moves the epoch on, and the next review judges it', () => {
  const session = { task: deriveTaskSpec('Refactor the cache module and have it reviewed.') };
  recordTaskReview(session, { by: 'code-review', text: 'Checked.\nVERDICT: PASS', toolCalls: 1 });
  noteTaskWorker(session, { agentId: 'agent_2', agentType: 'general-purpose' });
  assert.equal(currentReviews(session).current.length, 0, 'the review predates the worker\'s edits');
  const review = recordTaskReview(session, { by: 'code-review', text: 'High: cache.js:3 never evicts.\nVERDICT: FAIL', toolCalls: 2 });
  assert.deepEqual(review.reviewed, ['agent_2']);
  const again = recordTaskReview(session, { by: 'security-review', text: 'VERDICT: PASS', toolCalls: 2 });
  assert.deepEqual(again.reviewed, [], 'a worker is judged once');
});

test('the experience store amends a judged run: fail rejects, pass verifies a clean run', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-review-exp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = openExperienceStore(path.join(dir, 'x.sqlite'));
  if (!store) return t.skip('node:sqlite unavailable');
  t.after(() => store.close());
  store.record({ sessionId: 's1', agentId: 'agent_1', agentType: 'general-purpose', outcome: 'verified', task: 'fix it' });
  store.record({ sessionId: 's1', agentId: 'agent_2', agentType: 'general-purpose', outcome: 'clean', task: 'tidy it' });
  store.record({ sessionId: 's1', agentId: 'agent_3', agentType: 'general-purpose', outcome: 'failed', task: 'x' });
  assert.equal(store.amend({ sessionId: 's1', agentId: 'agent_1', verdict: 'fail', detail: 'misses empty input' }), 1);
  assert.equal(store.amend({ sessionId: 's1', agentId: 'agent_2', verdict: 'pass' }), 1);
  assert.equal(store.amend({ sessionId: 's1', agentId: 'agent_3', verdict: 'pass' }), 0, 'a pass does not rescue a failed run');
  assert.equal(store.amend({ sessionId: 's1', agentId: 'agent_1', verdict: 'inconclusive' }), 0);
  const rows = Object.fromEntries(store.runs().map((row) => [row.agentId, row]));
  assert.equal(rows.agent_1.outcome, 'rejected');
  assert.match(rows.agent_1.detail, /independent review failed: misses empty input/);
  assert.equal(rows.agent_2.outcome, 'verified');
  assert.equal(rows.agent_2.verdict, 'independently_verified');
  assert.equal(rows.agent_3.outcome, 'failed');
});

test('a delegated fix that fails review is recorded as rejected in the agent\'s track record', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-review-worker-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => closeExperienceStores());
  const configDir = path.join(root, '.config-oasis');
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(root, 'sum.mjs'), 'export const sum = (a, b) => a - b;\n');
  await writeFile(path.join(root, 'sum.test.mjs'), "import test from 'node:test';\nimport assert from 'node:assert';\nimport { sum } from './sum.mjs';\ntest('sum', () => assert.equal(sum(2, 3), 5));\n");
  const call = (id, name, args) => ({ role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] });
  const parentScript = [
    call('p1', 'task', { description: 'fix sum', prompt: 'Fix sum.mjs so sum.test.mjs passes.', subagent_type: 'general-purpose' }),
    call('p2', 'task', { description: 'review sum', prompt: 'Review the change to sum.mjs.', subagent_type: 'code-review' }),
    { role: 'assistant', content: 'The reviewer found a problem with the fix.' }
  ];
  const workerScript = [
    call('w0', 'read_file', { path: 'sum.mjs' }),
    call('w1', 'write_file', { path: 'sum.mjs', content: 'export const sum = (a, b) => a + b;\n' }),
    call('w2', 'run_command', { command: 'node', args: ['--test', 'sum.test.mjs'] }),
    { role: 'assistant', content: 'Fixed sum.mjs; node --test sum.test.mjs passes.' }
  ];
  const reviewerScript = [call('r1', 'read_file', { path: 'sum.mjs' }), { role: 'assistant', content: '1. High: sum.mjs:1 drops type checks the callers rely on.\nVERDICT: FAIL' }];
  const steps = { parent: 0, worker: 0, reviewer: 0 };
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    const system = String(payload.messages[0].content);
    const user = String((payload.messages.find((m) => m.role === 'user') || {}).content || '');
    let message;
    if (/SUBAGENT MODE/.test(system) && /Review the change/.test(user)) message = reviewerScript[Math.min(steps.reviewer++, reviewerScript.length - 1)];
    else if (/SUBAGENT MODE/.test(system)) message = workerScript[Math.min(steps.worker++, workerScript.length - 1)];
    else message = parentScript[Math.min(steps.parent++, parentScript.length - 1)];
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SUBAGENT_EFFORT: '', CLAUDE_CODE_SUBAGENT_EFFORT: '', OASIS_AGENT_EXPERIENCE_FILE: path.join(configDir, 'exp.sqlite') };
  delete env.NODE_TEST_CONTEXT;
  delete env.OASIS_AGENT_EXPERIENCE;
  const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model: 'fixture', apiKey: '', maxSteps: 8 } });
  await runAgentTurn(session, 'Have an agent fix sum.mjs, then have the fix independently reviewed.', { autoApprove: true, env });
  assert.equal(session.taskWorkers.length, 1);
  const review = session.taskReviews.at(-1);
  assert.equal(review.verdict, 'fail');
  assert.deepEqual(review.reviewed, [session.taskWorkers[0].agentId]);
  closeExperienceStores();
  const store = openExperienceStore(env.OASIS_AGENT_EXPERIENCE_FILE);
  if (!store) return t.skip('node:sqlite unavailable');
  t.after(() => store.close());
  const worker = store.runs().find((row) => row.agentType === 'general-purpose');
  assert.ok(worker, 'the worker run was recorded');
  assert.equal(worker.outcome, 'rejected', 'its own passing test does not outweigh the failed review');
  assert.match(worker.detail, /independent review failed/);
});
