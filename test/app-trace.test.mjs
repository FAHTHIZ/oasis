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
