import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTrace, matchStep, traceToMarkdown, traceToJSON, turnStatusLabel } from '../app/core/trace.mjs';

const T = 1_700_000_000_000;
const entries = [
  { role: 'user', content: 'Add world to notes.txt', at: T },
  { role: 'assistant', content: '', tools: [
    { id: 'a', name: 'read_file', args: { path: 'notes.txt' }, startedAt: T + 1000, endedAt: T + 1200, ok: true, content: 'hello' },
    { id: 'b', name: 'write_file', args: { path: 'notes.txt', content: 'hello world', api_key: 'sk-1' }, startedAt: T + 3000, endedAt: T + 3100, ok: false, content: '{"error":"nope"}' }
  ] },
  { role: 'assistant', content: 'Retrying.', tools: [
    { id: 'c', name: 'edit_file', args: { path: 'notes.txt' }, startedAt: T + 5000, endedAt: T + 5200, ok: true },
    { id: 'd', name: 'run_command', args: { command: 'npm test' }, startedAt: T + 6000, endedAt: T + 10000, ok: true }
  ] },
  { role: 'worked', content: 'Worked for 10s', timings: [{ step: 1, startedAt: T + 100, totalMs: 800, inputTokens: 1200, outputTokens: 40, toolCalls: 1 }, { step: 2, startedAt: T + 1300, totalMs: 1600, outputTokens: 30 }] },
  { role: 'user', content: 'Now run it', at: T + 20000 },
  { role: 'assistant', content: '', tools: [{ id: 'e', name: 'run_command', args: { command: 'node a.js' }, startedAt: T + 21000 }] }
];

test('turns, steps, waterfall positions and stats come from the display entries', () => {
  const trace = buildTrace(entries, { now: T + 25000, running: true });
  assert.equal(trace.turns.length, 2);
  const [first, second] = trace.turns;
  assert.equal(first.prompt, 'Add world to notes.txt');
  assert.equal(first.steps.length, 4);
  assert.deepEqual(first.steps.map((step) => step.label), ['Read notes.txt', "Couldn't write notes.txt", 'Edited notes.txt', 'Ran the tests']);
  assert.equal(first.status, 'issues');
  assert.equal(turnStatusLabel(first.status), 'Done with failed steps');
  assert.equal(first.durationMs, 10000);
  assert.equal(first.steps[0].offset, 10);
  assert.equal(first.steps[3].width, 40);
  assert.deepEqual(first.files, ['notes.txt']);
  assert.equal(first.stats.failed, 1);
  assert.equal(first.stats.commands, 1);
  assert.equal(first.model.length, 2);
  assert.equal(first.model[0].offset, 1);
  assert.equal(first.stats.tokensIn, 1200);
  assert.equal(second.status, 'running');
  assert.equal(second.steps[0].outcome, 'running');
  assert.equal(second.steps[0].durationMs, 4000, 'a running step counts to now');
  assert.equal(trace.totals.steps, 5);
  assert.equal(trace.totals.files, 1);
});

test('filters and search narrow the steps', () => {
  const steps = buildTrace(entries, { now: T + 25000 }).turns[0].steps;
  assert.deepEqual(steps.filter((step) => matchStep(step, { filter: 'failed' })).map((step) => step.id), ['b']);
  assert.deepEqual(steps.filter((step) => matchStep(step, { filter: 'edit' })).map((step) => step.id), ['b', 'c']);
  assert.deepEqual(steps.filter((step) => matchStep(step, { filter: 'shell' })).map((step) => step.id), ['d']);
  assert.deepEqual(steps.filter((step) => matchStep(step, { query: 'npm' })).map((step) => step.id), ['d']);
});

test('errors and stops set the turn status; steering notes do not open a turn', () => {
  const trace = buildTrace([
    { role: 'user', content: 'a', at: T },
    { role: 'error', content: 'Provider said no' },
    { role: 'user', content: 'b', at: T + 10 },
    { role: 'user', content: 'also this', steer: true, at: T + 11 },
    { role: 'note', content: 'Stopped.' }
  ]);
  assert.deepEqual(trace.turns.map((turn) => turn.status), ['error', 'stopped']);
});

test('exports: Markdown for people, JSON without secrets', () => {
  const trace = buildTrace(entries, { now: T + 25000 });
  const md = traceToMarkdown(trace);
  assert.match(md, /## 1\. Add world to notes\.txt/);
  assert.match(md, /- Couldn't write notes\.txt \(FAILED, 0\.1s\)/);
  assert.match(md, /- Ran the tests — `npm test` \(ok, 4s\)/);
  const json = traceToJSON(trace);
  assert.equal(json.turns[0].steps[1].args.api_key, '[hidden]');
  assert.equal(json.turns[0].steps[1].output, '{"error":"nope"}');
  assert.equal(json.turns[0].model[0].offset, undefined);
});

test('time spent waiting for approval is kept apart from run time', () => {
  const trace = buildTrace([
    { role: 'user', content: 'Run it', at: T },
    { role: 'assistant', content: '', tools: [
      { id: 'w', name: 'run_command', args: { command: 'sleep 4' }, startedAt: T, endedAt: T + 25000, waitedMs: 21000, ok: true },
      { id: 'x', name: 'run_command', args: { command: 'npm test' }, startedAt: T + 26000, waitStartedAt: T + 26000 }
    ] }
  ], { now: T + 30000, running: true });
  const [done, waiting] = trace.turns[0].steps;
  assert.equal(done.durationMs, 25000);
  assert.equal(done.waitedMs, 21000);
  assert.equal(waiting.waitedMs, 4000, 'an open wait counts up to now');
  assert.match(traceToMarkdown(trace), /sleep 4.*\(ok, 4s, waited 21s for approval\)/);
  assert.equal(traceToJSON(trace).turns[0].steps[0].waitedMs, 21000);
});

test('a task step carries one lane per agent, with its own steps, files and tokens', async () => {
  const { buildTrace, agentLanes, budgetTokens, traceToMarkdown } = await import('../app/core/trace.mjs');
  const t0 = 1_000_000;
  const entries = [
    { role: 'user', content: 'two agents', at: t0 },
    { role: 'assistant', content: '', tools: [{ id: 't1', name: 'task', args: { description: '2 agents' }, startedAt: t0 + 100 }], subagents: [
      { id: 'agent_1', description: 'Count lines', status: 'completed', startedAt: t0 + 200, endedAt: t0 + 9_000, budget: '8.2k tokens · 2 requests', detail: 'cart.js: 12', log: [
        { label: 'Running wc -l *.js', name: 'run_command', startedAt: t0 + 300, endedAt: t0 + 900, ok: true },
        { label: 'Writing notes.txt', name: 'write_file', path: 'notes.txt', startedAt: t0 + 1000, endedAt: t0 + 1200, ok: true, lines: { added: 2, removed: 0 } }
      ] },
      { id: 'agent_2', description: 'List products', status: 'running', startedAt: t0 + 250, log: [{ label: 'Reading sales.csv', name: 'read_file', startedAt: t0 + 400 }] }
    ] }
  ];
  const trace = buildTrace(entries, { now: t0 + 10_100, running: true });
  const turn = trace.turns[0];
  const step = turn.steps[0];
  assert.equal(step.agents.length, 2);
  assert.equal(step.agents[0].steps.length, 2);
  assert.equal(step.agents[0].steps[1].lines.added, 2);
  assert.equal(step.agents[1].outcome, 'running');
  assert.equal(step.agents[1].steps[0].outcome, 'running');
  assert.deepEqual(turn.files, ['notes.txt'], 'files an agent changed count for the turn');
  assert.equal(turn.stats.agents, 2);
  assert.equal(turn.stats.agentSteps, 3);
  assert.equal(turn.stats.agentTokens, 8200);
  assert.ok(turn.now.some((line) => line.agent === 2 && /Reading sales\.csv/.test(line.text)), 'the Now strip says what agent 2 is doing');
  assert.match(traceToMarkdown(trace), /Agent 1: Count lines \(done/);
  assert.equal(budgetTokens('tokens 8,218, requests 2'), 8218);
  assert.equal(agentLanes(null).length, 0);
  // A lane saved before agents had times is drawn over its task step.
  const old = buildTrace([{ role: 'user', content: 'x', at: t0 }, { role: 'assistant', tools: [{ id: 't', name: 'task', args: {}, startedAt: t0, endedAt: t0 + 5000, ok: true }], subagents: [{ id: 'agent_1', description: 'a', status: 'completed' }] }], { now: t0 + 5000 });
  assert.ok(old.turns[0].steps[0].agents[0].width > 50);
});
