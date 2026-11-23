import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFaultSpec, faultPlan, faultLog, resetFaults, wrapModelFetch, withToolFaults } from '../src/fault-injection.mjs';
import { runScenario, SCENARIOS, judgeToolResult, nextAction } from '../src/reliability-lab.mjs';

const reply = (body) => async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const toolReply = { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{"path":"a.txt","content":"alpha"}' } }] } }] };

test('fault specs parse strictly', () => {
  assert.deepEqual(parseFaultSpec('model:429@1, tool:run_command:lost-reply@2-3,tool:*:slow@every2,model:reset@p0.5').map((rule) => [rule.target, rule.tool, rule.fault, rule.schedule.kind]), [
    ['model', null, '429', 'range'], ['tool', 'run_command', 'lost-reply', 'range'], ['tool', '*', 'slow', 'every'], ['model', null, 'reset', 'probability']
  ]);
  assert.deepEqual(parseFaultSpec(''), []);
  assert.throws(() => parseFaultSpec('model:418'), /cannot read "model:418"/);
  assert.throws(() => parseFaultSpec('tool:write_file:explode'), /cannot read/);
  assert.throws(() => parseFaultSpec('model:429@soon'), /unknown schedule/);
  assert.equal(faultPlan({}), null, 'off unless OASIS_FAULTS is set');
});

test('schedules pick the right calls and probability is reproducible from the seed', async () => {
  const run = async (spec, calls, seed = '1') => {
    resetFaults();
    const env = { OASIS_FAULTS: spec, OASIS_FAULTS_SEED: seed };
    const fetch = wrapModelFetch(reply({ choices: [{ message: { role: 'assistant', content: 'ok' } }] }), env);
    const statuses = [];
    for (let i = 0; i < calls; i++) statuses.push((await fetch('http://x')).status);
    resetFaults();
    return statuses;
  };
  assert.deepEqual(await run('model:503@2', 3), [200, 503, 200]);
  assert.deepEqual(await run('model:503@2-3', 4), [200, 503, 503, 200]);
  assert.deepEqual(await run('model:500@every2', 4), [200, 500, 200, 500]);
  const a = await run('model:429@p0.5', 20, '7');
  assert.deepEqual(await run('model:429@p0.5', 20, '7'), a, 'same seed, same faults');
  assert.ok(a.includes(429) && a.includes(200));
});

test('model faults: HTTP errors carry a short retry hint, resets throw like undici, bodies are damaged as asked', async () => {
  resetFaults();
  const env = { OASIS_FAULTS: 'model:429@1,model:reset@2,model:truncate@3,model:empty@4,model:malformed-args@5,model:garbage@6' };
  const fetch = wrapModelFetch(reply(toolReply), env);
  const limited = await fetch('http://x');
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('retry-after-ms'), '1');
  await assert.rejects(fetch('http://x'), (error) => error instanceof TypeError && error.cause.code === 'ECONNRESET');
  const cut = await (await fetch('http://x')).text();
  assert.throws(() => JSON.parse(cut));
  assert.deepEqual((await (await fetch('http://x')).json()).choices, []);
  const broken = await (await fetch('http://x')).json();
  assert.throws(() => JSON.parse(broken.choices[0].message.tool_calls[0].function.arguments));
  assert.match(await (await fetch('http://x')).text(), /^<html>/);
  assert.equal((await fetch('http://x')).status, 200, 'past the schedule, requests pass through');
  assert.deepEqual(faultLog().map((entry) => entry.fault), ['429', 'reset', 'truncate', 'empty', 'malformed-args', 'garbage']);
  resetFaults();
});

test('tool faults: error stops before running, lost-reply runs and then fails, other tools are untouched', async () => {
  resetFaults();
  const env = { OASIS_FAULTS: 'tool:run_command:lost-reply@1,tool:write_file:error@1' };
  let ran = 0;
  await assert.rejects(withToolFaults('run_command', env, async () => { ran++; return { ok: true }; }), /may or may not have completed/);
  assert.equal(ran, 1, 'the lost-reply call really ran');
  assert.deepEqual(await withToolFaults('run_command', env, async () => { ran++; return { ok: true }; }), { ok: true });
  await assert.rejects(withToolFaults('write_file', env, async () => { ran++; }), /EIO/);
  assert.equal(ran, 2, 'the failed write never ran');
  assert.equal(await withToolFaults('read_file', env, async () => 'x'), 'x');
  resetFaults();
});

test('the stand-in model retries failures and trusts an after-failure verdict', () => {
  assert.equal(judgeToolResult('{"ok":true}'), 'ok');
  assert.equal(judgeToolResult('{"error":"EIO"}'), 'failed');
  assert.equal(judgeToolResult('{"exitCode":1}'), 'failed');
  assert.equal(judgeToolResult('{"error":"lost","afterFailure":{"state":"changed"}}'), 'took-effect');
  const plan = [{ name: 'a', args: {} }, { name: 'b', args: {} }];
  const tool = (id, content) => [{ role: 'assistant', tool_calls: [{ id }] }, { role: 'tool', tool_call_id: id, content }];
  assert.equal(nextAction(plan, [{ role: 'user', content: 'go' }]).call.name, 'a');
  assert.equal(nextAction(plan, tool('1', '{"error":"x"}')).call.name, 'a');
  assert.equal(nextAction(plan, tool('1', '{"ok":true}')).call.name, 'b');
  assert.equal(nextAction(plan, [...tool('1', '{"ok":true}'), ...tool('2', '{"ok":true}')]).done, true);
  assert.equal(nextAction(plan, [1, 2, 3, 4].flatMap((n) => tool(String(n), '{"error":"x"}'))).gaveUp, true);
});

const pick = (id) => SCENARIOS.find((scenario) => scenario.id === id);

test('lab: bad 200 bodies and empty replies are retried instead of ending the task', async () => {
  for (const id of ['model-truncated-body', 'model-garbage-body', 'model-empty-reply']) {
    const result = await runScenario(pick(id));
    assert.equal(result.passed && result.completed, true, id + ': ' + JSON.stringify(result));
    assert.equal(result.injected, 1);
  }
});

test('lab: a lost reply is reconciled live, so the append is not repeated; without the check it is', async () => {
  const lost = pick('lost-reply-append-command');
  const withCheck = await runScenario(lost);
  assert.equal(withCheck.passed, true, JSON.stringify(withCheck));
  assert.equal(withCheck.duplicateEffects, 0);
  const without = await runScenario(lost, { env: { ...process.env, OASIS_AFTER_FAILURE_CHECK: '0' } });
  assert.equal(without.duplicateEffects, 1, 'the ablation shows the duplicate the check prevents');
  // A failure before the command ran must not be mistaken for success.
  const early = await runScenario(pick('tool-error-before-command'));
  assert.equal(early.passed, true, JSON.stringify(early));
});
