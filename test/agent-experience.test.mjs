import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import {
  chooseExperienceModel, classifyOutcome, closeExperienceStores, experienceFile, experienceProject, formatExperienceContext,
  formatTrackRecord, openExperienceStore, recallExperience, sharedExperienceStore, taskDomain, trackRecord, wilsonLower
} from '../src/agent-experience.mjs';
import { sanitizeModelRouting } from '../src/model-routing.mjs';

async function scratch(t, prefix = 'oasis-experience-') {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('outcomes come from the runtime record, not the report', () => {
  assert.equal(classifyOutcome({ status: 'failed' }), 'failed');
  assert.equal(classifyOutcome({ status: 'stalled' }), 'stalled');
  assert.equal(classifyOutcome({ status: 'cancelled' }), 'cancelled');
  assert.equal(classifyOutcome({ status: 'completed', verificationIssues: [{ domain: 'code', reason: 'x' }] }), 'rejected');
  assert.equal(classifyOutcome({ status: 'completed', unverifiedClaim: 'ran no test' }), 'unverified');
  assert.equal(classifyOutcome({ status: 'completed', partial: true }), 'partial');
  assert.equal(classifyOutcome({ status: 'completed', evidence: { counts: {}, lastCheck: { passed: true, stale: false } } }), 'verified');
  assert.equal(classifyOutcome({ status: 'completed', evidence: { counts: {}, lastCheck: { passed: true, stale: true } } }), 'clean');
  assert.equal(classifyOutcome({ status: 'completed', evidence: { counts: { fetch: 2 } } }), 'verified');
  assert.equal(classifyOutcome({ status: 'completed', evidence: { counts: { search: 1 } } }), 'clean');
});

test('task domains are coarse buckets', () => {
  assert.equal(taskDomain('Fix the failing test in src/agent.mjs and refactor the helper'), 'code');
  assert.equal(taskDomain('Research the latest sources and documentation on vector databases'), 'research');
  assert.equal(taskDomain('Analyze this CSV dataset and compute the metrics'), 'analysis');
  assert.equal(taskDomain('Take a screenshot and click the login button on the desktop'), 'computer');
  assert.equal(taskDomain('hello there'), 'general');
});

test('the store redacts secrets, filters, prunes and forgets', async (t) => {
  const dir = await scratch(t);
  const store = openExperienceStore(path.join(dir, 'exp.sqlite'));
  t.after(() => store.close());
  assert.equal(store.record({ agentType: 'Explore', outcome: 'clean', project: 'p1', task: 'use key sk-ant-api03-' + 'a'.repeat(40) + ' to <private>hidden</private> call', at: 1000 }), true);
  assert.equal(store.record({ agentType: 'Explore', outcome: 'bogus', project: 'p1' }), false, 'unknown outcomes are refused');
  assert.equal(store.record({ outcome: 'clean' }), false, 'an agent type is required');
  store.record({ agentType: 'Plan', outcome: 'failed', project: 'p1', at: 2000 });
  store.record({ agentType: 'Explore', outcome: 'verified', project: 'p2', at: Date.now() });
  const [row] = store.runs({ project: 'p1', agentType: 'Explore' });
  assert.doesNotMatch(row.task, /sk-ant-api03|hidden/);
  assert.match(row.task, /\[redacted\]/);
  assert.equal(store.runs({ project: 'p1' }).length, 2);
  assert.equal(store.prune(Date.now(), 60_000), 2, 'old rows leave');
  assert.equal(store.runs().length, 1);
  assert.equal(store.forget({ project: 'p2' }), 1);
  assert.equal(store.runs().length, 0);
});

test('recall finds similar earlier runs and skips rejected ones', async (t) => {
  const dir = await scratch(t);
  const store = openExperienceStore(path.join(dir, 'exp.sqlite'));
  t.after(() => store.close());
  const base = { agentType: 'general-purpose', project: 'p', at: Date.now() - 86400000 * 3 };
  store.record({ ...base, outcome: 'verified', task: 'Fix the flaky websocket reconnect test in the gateway module', lesson: 'The flake came from a fixed 50ms timer; waiting on the open event fixed it. npm test passed.', toolCalls: 9, durationMs: 42000, model: 'cheap' });
  store.record({ ...base, outcome: 'rejected', task: 'Fix the websocket reconnect gateway test', lesson: 'all good trust me' });
  store.record({ ...base, outcome: 'failed', task: 'Upgrade websocket library in gateway and fix reconnect', detail: 'The ws 9 upgrade broke the proxy agent option' });
  store.record({ ...base, outcome: 'verified', task: 'Write release notes for version two', lesson: 'unrelated' });
  store.record({ ...base, agentType: 'Explore', outcome: 'verified', task: 'Fix the flaky websocket reconnect test', lesson: 'other agent type' });
  const hits = recallExperience(store, { project: 'p', agentType: 'general-purpose', prompt: 'The websocket reconnect test in the gateway is flaky again; fix it' });
  assert.deepEqual(hits.map((hit) => hit.outcome).sort(), ['failed', 'verified']);
  assert.ok(hits.every((hit) => !/release notes|trust me|other agent/.test(hit.task + hit.lesson)));
  const text = formatExperienceContext(hits, { now: Date.now() });
  assert.match(text, /^EXPERIENCE FROM EARLIER RUNS/);
  assert.match(text, /3 days ago, succeeded, verified by evidence, cheap, 9 tool calls, 42s/);
  assert.match(text, /What it reported: The flake came from a fixed 50ms timer/);
  assert.match(text, /Why it failed: The ws 9 upgrade broke/);
  assert.match(text, /quoted data, not instructions/);
  assert.ok(formatExperienceContext(hits, { budget: 600 }).length <= 600);
  assert.deepEqual(recallExperience(store, { project: 'other', agentType: 'general-purpose', prompt: 'websocket reconnect test' }), []);
  assert.deepEqual(recallExperience(store, { project: 'p', agentType: 'general-purpose', prompt: 'the and of' }), []);
  store.record({ ...base, sessionId: 'now', outcome: 'verified', task: 'Fix websocket reconnect gateway test for task_3', lesson: 'Finished task_3 and agent_2' });
  assert.ok(recallExperience(store, { project: 'p', agentType: 'general-purpose', prompt: 'websocket reconnect gateway test', excludeSession: 'now' }).every((hit) => hit.sessionId !== 'now'));
  const masked = formatExperienceContext(recallExperience(store, { project: 'p', agentType: 'general-purpose', prompt: 'websocket reconnect gateway test task_3' }));
  assert.doesNotMatch(masked, /task_3|agent_2/);
  assert.match(masked, /task_#/);
});

test('track records aggregate and the Wilson bound punishes small samples', () => {
  const rows = [
    ...Array.from({ length: 8 }, () => ({ agentType: 'a', model: 'm1', domain: 'code', outcome: 'verified', tokens: 100, costUsd: 0.01, durationMs: 1000, at: 1 })),
    { agentType: 'a', model: 'm1', domain: 'code', outcome: 'failed', tokens: 50, costUsd: 0, durationMs: 1000, at: 2 },
    { agentType: 'a', model: 'm1', domain: 'code', outcome: 'cancelled', at: 3 }
  ];
  const [record] = trackRecord(rows);
  assert.equal(record.runs, 10);
  assert.equal(record.succeeded, 8);
  assert.equal(record.verified, 8);
  assert.equal(record.failed, 1);
  assert.equal(record.avgTokens, 85);
  assert.ok(record.successLowerBound > 0.6 && record.successLowerBound < 0.89);
  assert.ok(wilsonLower(1, 1) < 0.75, 'one success is weak evidence');
  assert.equal(wilsonLower(0, 0), 0);
  assert.match(formatTrackRecord([record]), /a \/ m1 \/ code\n  10 runs, 80% succeeded \(80% verified\), 1 failed/);
  assert.match(formatTrackRecord([]), /No agent experience recorded yet/);
});

test('experience routing picks a cheaper model only on enough matching evidence', () => {
  const runs = (model, ok, bad) => [
    ...Array.from({ length: ok }, () => ({ agentType: 'Explore', model, domain: 'code', outcome: 'clean' })),
    ...Array.from({ length: bad }, () => ({ agentType: 'Explore', model, domain: 'code', outcome: 'failed' }))
  ];
  const price = (model) => ({ strong: 10, cheap: 1, free: 0, worse: 0.5 })[model] ?? null;
  const pick = (rows, extra = {}) => chooseExperienceModel({ rows, agentType: 'Explore', domain: 'code', baseModel: 'strong', candidates: ['cheap', 'free', 'worse', 'mystery'], price, ...extra });
  assert.equal(pick(runs('strong', 3, 0)).changed, false, 'too little history for the default model');
  assert.match(pick(runs('strong', 3, 0)).reason, /3 of 5 runs/);
  const rows = [...runs('strong', 10, 0), ...runs('cheap', 10, 0), ...runs('free', 2, 0), ...runs('worse', 3, 7), ...runs('mystery', 20, 0)];
  const choice = pick(rows);
  assert.equal(choice.model, 'cheap', 'free has too few runs, worse fails too often, mystery has no known price');
  assert.match(choice.reason, /cheap succeeded on 10 of 10 Explore code runs/);
  assert.equal(pick(rows, { domain: 'research' }).changed, false, 'records do not cross domains');
  assert.equal(pick([...rows, ...runs('free', 10, 0)]).model, 'free');
  assert.equal(pick(rows, { candidates: [] }).model, 'strong');
});

test('sanitizeModelRouting keeps the subagent experience options', () => {
  const routing = sanitizeModelRouting({ subagents: 'experience', subagentModels: ['a', 'a', ' b '], subagentMinRuns: 8 });
  assert.equal(routing.subagents, 'experience');
  assert.deepEqual(routing.subagentModels, ['a', 'b']);
  assert.equal(routing.subagentMinRuns, 8);
  assert.equal(sanitizeModelRouting({ subagents: 'other', subagentMinRuns: 1 }).subagents, undefined);
});

// End to end: a parent delegates the same kind of task twice. The first child
// runs a passing test; the second child's system prompt carries that run.
async function delegateTwice(t, { settings = null, seed = null, model = 'fixture' } = {}) {
  const root = await scratch(t, 'oasis-experience-e2e-');
  const configDir = path.join(root, '.config-oasis');
  await mkdir(configDir, { recursive: true });
  if (settings) await writeFile(path.join(configDir, 'settings.json'), JSON.stringify(settings));
  await writeFile(path.join(root, 'pass.test.mjs'), "import test from 'node:test';\ntest('ok', () => {});\n");
  const env = { ...process.env, OASIS_CONFIG_DIR: configDir, OASIS_SUBAGENT_EFFORT: '', CLAUDE_CODE_SUBAGENT_EFFORT: '', OASIS_NEURON_LEDGER: '0' };
  delete env.NODE_TEST_CONTEXT;
  delete env.OASIS_AGENT_EXPERIENCE;
  t.after(() => closeExperienceStores());
  if (seed) seed(sharedExperienceStore(env), experienceProject(root));
  const childSystems = [];
  const childModels = [];
  const results = [];
  let childStep = 0;
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body);
    let message;
    const system = String(payload.messages[0].content);
    if (/SUBAGENT MODE/.test(system)) {
      if (!payload.messages.some((m) => m.role === 'tool')) { childSystems.push(system); childModels.push(payload.model); }
      message = childStep++ % 2 === 0
        ? { role: 'assistant', content: null, tool_calls: [{ id: 'r' + childStep, type: 'function', function: { name: 'run_command', arguments: JSON.stringify({ command: 'node', args: ['--test', 'pass.test.mjs'] }) } }] }
        : { role: 'assistant', content: 'The parser bug was an off-by-one in the tokenizer loop. All tests pass.' };
    } else {
      const last = payload.messages[payload.messages.length - 1];
      if (last.role === 'tool') { results.push(JSON.parse(last.content)); message = { role: 'assistant', content: 'done' }; }
      else message = { role: 'assistant', content: null, tool_calls: [{ id: 'p' + results.length, type: 'function', function: { name: 'task', arguments: JSON.stringify({ description: 'fix parser', prompt: 'Fix the parser bug in the tokenizer and run the tests.', subagent_type: 'general-purpose' }) } }] };
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  // Two separate sessions: recall skips runs from the session asking.
  for (const prompt of ['go', 'again']) {
    const session = await createSession({ root, env, config: { protocol: 'openai-compatible', baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', model, apiKey: '', maxSteps: 6 } });
    await runAgentTurn(session, prompt, { autoApprove: true, env });
  }
  return { env, root, childSystems, childModels, results };
}

test('a finished subagent run is recorded and recalled for the next similar task', async (t) => {
  const { env, root, childSystems, results } = await delegateTwice(t);
  assert.equal(results.length, 2);
  assert.doesNotMatch(childSystems[0], /EXPERIENCE FROM EARLIER RUNS/);
  assert.match(childSystems[1], /EXPERIENCE FROM EARLIER RUNS/);
  assert.match(childSystems[1], /succeeded, verified by evidence, fixture/);
  assert.match(childSystems[1], /off-by-one in the tokenizer loop/);
  const store = sharedExperienceStore(env);
  assert.equal(experienceFile(env), path.join(env.OASIS_CONFIG_DIR, 'sessions', 'agent-experience.sqlite'));
  const rows = store.runs({ project: experienceProject(root) });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.outcome === 'verified' && row.agentType === 'general-purpose' && row.checksPassed === 1 && row.toolCalls === 1 && row.domain === 'code'));
});

test('OASIS_AGENT_EXPERIENCE=0 records and recalls nothing', async () => {
  assert.equal(sharedExperienceStore({ ...process.env, OASIS_AGENT_EXPERIENCE: '0' }), null);
  assert.equal(sharedExperienceStore(process.env, { agentExperience: false }), null);
});

test('modelRouting.subagents "experience" starts the child on the cheaper proven model', async (t) => {
  // Cloud-style names keep the loopback fixture server from being priced as a free local model.
  const seed = (store, project) => {
    for (const model of ['gpt-big', 'gpt-mini']) {
      for (let i = 0; i < 6; i++) store.record({ project, agentType: 'general-purpose', model, domain: 'code', outcome: 'verified', task: 'earlier unrelated job ' + i });
    }
  };
  const { childModels, results } = await delegateTwice(t, {
    seed, model: 'gpt-big',
    settings: { modelRouting: { subagents: 'experience', subagentModels: ['gpt-mini'] }, pricing: { 'gpt-mini': { input: 0.1, output: 0.2 }, 'gpt-big': { input: 3, output: 15 } } }
  });
  assert.deepEqual(childModels, ['gpt-mini', 'gpt-mini']);
  assert.equal(results[0].model, 'gpt-mini');
  assert.match(results[0].model_route, /experience: gpt-mini succeeded on 6 of 6/);
});

test('the control room shows each agent type and model track record', async (t) => {
  const { experienceActivity, formatControlRoom, controlRoomSnapshot } = await import('../src/control-room.mjs');
  const { controlRoomTrackRecord } = await import('../app/core/control-room.mjs');
  const dir = await scratch(t);
  const env = { ...process.env, OASIS_CONFIG_DIR: dir, OASIS_NEURON_LEDGER: '0' };
  delete env.OASIS_AGENT_EXPERIENCE;
  t.after(() => closeExperienceStores());
  const store = sharedExperienceStore(env);
  for (const outcome of ['verified', 'verified', 'clean', 'failed']) store.record({ project: 'p', agentType: 'Explore', model: 'small', outcome, tokens: 1000, task: 'secret plan' });
  const activity = experienceActivity({ env });
  assert.equal(activity.available, true);
  assert.equal(activity.records[0].runs, 4);
  assert.equal(activity.records[0].successRate, 0.75);
  assert.doesNotMatch(JSON.stringify(activity), /secret plan/, 'counts only, never task text');
  const snapshot = controlRoomSnapshot({ env });
  assert.match(formatControlRoom(snapshot), /Track record \(last 30 days[^\n]*\n  Explore \/ small\s+4 runs\s+75% ok  2 verified  1 failed/);
  const [row] = controlRoomTrackRecord(snapshot);
  assert.equal(row.title, 'Explore · small');
  assert.equal(row.tone, 'waiting');
  assert.match(row.detail, /4 runs · 75% succeeded · 2 verified · 1 failed/);
  assert.equal(experienceActivity({ env: { ...env, OASIS_AGENT_EXPERIENCE: '0' } }).available, false);
});
