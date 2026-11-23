import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadWorkflows, runWorkflow } from '../src/workflows.mjs';
import { loadCustomCommands } from '../src/commands.mjs';
import os from 'node:os';

const SOURCE = await readFile(new URL('../src/workflows/debate.js', import.meta.url), 'utf8');

// A scripted debate: P1 (remote work raises productivity) vs P2 (it lowers it).
function scripted(prompts) {
  return async ({ prompt, label }) => {
    prompts.push({ label, prompt });
    if (label === 'frame positions') return JSON.stringify({ positions: [{ name: 'Raises', thesis: 'Remote work raises productivity.' }, { name: 'Lowers', thesis: 'Remote work lowers productivity.' }], cruxes: [{ question: 'Do self-reported gains match measured output?', settled_by: 'Randomized trials with measured output' }] });
    if (label === 'open P1') return JSON.stringify({ arguments: [
      { claim: 'A randomized trial found a 13% performance increase for home workers.', url: 'https://trial.example.org/ctrip', quote: 'home working led to a 13% performance increase' },
      { claim: 'Commuting time saved is redirected to work.', url: '', quote: '' }
    ], confidence: 0.7, weakest_point: 'Collaboration may suffer.' });
    if (label === 'open P2') return JSON.stringify({ arguments: [
      { claim: 'Data-entry workers were 18% less productive at home.', url: 'https://study.example.com/india', quote: 'workers were 18% less productive at home' },
      { claim: 'All surveys show remote workers slack off.', url: 'https://blog.example.net/opinion', quote: 'remote workers slack off' }
    ], confidence: 0.6 });
    if (label === 'round 1 P1') return JSON.stringify({ moves: [
      { act: 'concede', target: 'P2.1' },
      { act: 'challenge', target: 'P2.2', reason: 'An opinion blog, not a survey; no data.' }
    ], confidence: 0.6, would_change_mind: 'Trials showing lower measured output in knowledge work.' });
    if (label === 'round 1 P2') return JSON.stringify({ moves: [
      { act: 'challenge', target: 'P1.1', reason: 'One call-centre firm does not generalize.' },
      { act: 'withdraw', target: 'P2.2' },
      { act: 'concede', target: 'P2.1' },
      { act: 'counter', target: 'P1.2', claim: 'Saved commute time mostly goes to leisure.', url: 'https://time.example.org/use', quote: 'saved commuting time was mostly spent on leisure' }
    ], confidence: 0.5 });
    if (label === 'check P1.1') return JSON.stringify({ verdict: 'supported', note: 'The trial reports a 13% increase; it covers one firm.', url: 'https://trial.example.org/ctrip', independent_sources: 1 });
    if (label === 'check P1.2') return JSON.stringify({ verdict: 'unsettled', note: 'Time-use data is mixed.' });
    if (label === 'judge') return JSON.stringify({ ruling: 'Effects depend on task type: gains in individual work (P1.1), losses in routine data entry (P2.1).', winner: 'split', confidence: 0.55, consensus: ['P2.1 stands: data entry lost productivity at home.'], dissent: ['P1 and P2 disagree whether P1.1 generalizes.'], cruxes: [{ question: 'Does P1.1 replicate outside call centres?', settled_by: 'Trials in other occupations' }] });
    throw new Error('unexpected agent ' + label);
  };
}

test('debate: frame, opening, typed moves, fact-checks of disputed points, judged ledger', async () => {
  const prompts = [];
  const state = await runWorkflow({ source: SOURCE, args: 'Does remote work raise productivity? --rounds 1', runAgent: scripted(prompts), structuredRetries: 1 });
  assert.equal(state.status, 'completed', state.error);
  const report = state.result;
  assert.deepEqual(state.phases.map((phase) => phase.title), ['Frame', 'Opening', 'Rebuttal', 'Fact-check', 'Judgement']);
  assert.deepEqual(prompts.map((item) => item.label), ['frame positions', 'open P1', 'open P2', 'round 1 P1', 'round 1 P2', 'check P1.1', 'check P1.2', 'judge']);

  // Moves: P2.1 conceded by P1 (P2 conceding its own is ignored), P2.2 withdrawn, P1.2 countered by P2.3.
  assert.match(report, /\| P2\.1 \| Data-entry workers .* \| conceded \(conceded by P1\) \|/);
  assert.match(report, /\| P2\.2 \| .* \| withdrawn \|/);
  assert.match(report, /\| P2\.3 \| Saved commute time mostly goes to leisure\. \(answers P1\.2\) \|/);
  // Only disputed, unconceded arguments are fact-checked, by agents that never saw the debate.
  assert.match(report, /\| P1\.1 \| .* \| supported: The trial reports a 13% increase/);
  assert.match(report, /\| P1\.2 \| .* \| reasoning \| unsettled: Time-use data is mixed\. \|/);
  const checker = prompts.find((item) => item.label === 'check P1.1').prompt;
  assert.match(checker, /One call-centre firm does not generalize/);
  assert.doesNotMatch(checker, /You advocate/);
  // Evidence tally: P1 = 3 (P1.1 supported) + 0.25 (P1.2 unsettled, unsourced so half); P2 = 3 (P2.1 conceded) + 0 (withdrawn) + 1 (P2.3 unchallenged).
  assert.match(report, /\| P1 Raises \| Remote work raises productivity\. \| 3\.25 \| 1 supported, 1 unsettled \| 70% → 60% \|/);
  assert.match(report, /\| P2 Lowers \| Remote work lowers productivity\. \| 4 \| 1 conceded, 1 withdrawn, 1 unchallenged \| 60% → 50% \|/);
  assert.match(report, /\*\*Ruling\*\* \(55%\): Effects depend on task type/);
  assert.match(report, /## Cruxes\n\n- Does P1\.1 replicate outside call centres\? Settled by: Trials in other occupations/);
  assert.match(report, /## What would change their minds\n\n- P1: Trials showing lower measured output/);
  const judge = prompts.find((item) => item.label === 'judge').prompt;
  assert.match(judge, /do not use tools and add no facts of your own/);
  assert.match(judge, /"evidence_score": 3\.25/);
});

test('debate: given positions skip framing; a failed advocate forfeits; fewer than two ends it', async () => {
  const prompts = [];
  const base = scripted(prompts);
  const state = await runWorkflow({ source: SOURCE, args: { question: 'Q?', positions: ['Raises', 'Lowers'], rounds: 1 }, runAgent: async (call) => (call.label === 'open P2' ? Promise.reject(new Error('rejected')) : base(call)), structuredRetries: 1 });
  assert.equal(state.status, 'completed');
  assert.ok(!prompts.some((item) => item.label === 'frame positions'));
  assert.match(state.result, /could not run: 1 of 2 advocates/);
  const usage = await runWorkflow({ source: SOURCE, args: '', runAgent: base });
  assert.match(usage.result, /^Usage: \/debate/);
});

test('debate is a built-in workflow and therefore the /debate command', async () => {
  const workflows = await loadWorkflows(os.tmpdir(), { env: { ...process.env, HOME: os.tmpdir(), OASIS_CONFIG_DIR: os.tmpdir() + '/none' } });
  assert.equal(workflows.get('debate').scope, 'builtin');
  const commands = await loadCustomCommands(os.tmpdir(), { env: { ...process.env, HOME: os.tmpdir(), OASIS_CONFIG_DIR: os.tmpdir() + '/none' } });
  assert.ok(commands.get('debate').workflow);
});
