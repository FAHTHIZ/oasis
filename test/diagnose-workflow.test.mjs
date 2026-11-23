import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { runWorkflow } from '../src/workflows.mjs';

const SOURCE = await readFile(new URL('../src/workflows/diagnose.js', import.meta.url), 'utf8');
const PROBLEM = 'The login test passes locally but fails on CI with "session undefined".';

const framed = { hypotheses: [
  { hypothesis: 'A race in session setup', prediction: 'Fails intermittently; passes with --runInBand' },
  { hypothesis: 'A timezone difference on the runner', prediction: 'Fails locally with TZ=UTC' },
  { hypothesis: 'A missing SESSION_SECRET env var on CI', prediction: 'The CI env lacks SESSION_SECRET' }
] };
const r = (pairs) => Object.entries(pairs).map(([hypothesis, rating]) => ({ hypothesis, rating }));

function scripted(prompts, overrides = {}) {
  return async ({ prompt, label }) => {
    prompts.push({ label, prompt });
    if (overrides[label]) return JSON.stringify(overrides[label]);
    if (label.startsWith('hypothesize')) return JSON.stringify({ hypotheses: [{ hypothesis: 'Race in session setup ' + label, prediction: 'intermittent' }, { hypothesis: 'Missing env var', prediction: 'env lacks it' }] });
    if (label === 'frame hypotheses') return JSON.stringify(framed);
    if (label === 'falsify H1') return JSON.stringify({ verdict: 'survived', observations: [
      { what: 'Fails 3 of 10 runs on CI, never with --runInBand', how: 'ran', source: 'npm test -- --runInBand', ratings: r({ H1: '++', H2: '-', H3: '-' }) },
      { what: 'The test fails', how: 'read', source: 'ci.log', ratings: r({ H1: '+', H2: '+', H3: '+' }) }
    ] });
    if (label === 'falsify H2') return JSON.stringify({ verdict: 'refuted', note: 'Passes locally with TZ=UTC.', observations: [{ what: 'Passes locally with TZ=UTC', how: 'ran', source: 'TZ=UTC npm test', ratings: r({ H1: '0', H2: '--', H3: '0' }) }] });
    if (label === 'falsify H3') return JSON.stringify({ verdict: 'refuted', observations: [{ what: 'SESSION_SECRET is set in the CI env', how: 'read', source: '.github/workflows/ci.yml:22', ratings: r({ H1: '+', H2: '0', H3: '--' }) }] });
    throw new Error('unexpected agent ' + label);
  };
}

test('diagnose: blind hypotheses, one falsifier each, ACH scoring and a settled conclusion', async () => {
  const prompts = [];
  const state = await runWorkflow({ source: SOURCE, args: PROBLEM + ' --agents 2', runAgent: scripted(prompts), structuredRetries: 1 });
  assert.equal(state.status, 'completed', state.error);
  assert.deepEqual(state.phases.map((phase) => phase.title), ['Hypothesize', 'Frame', 'Falsify', 'Discriminate', 'Conclusion']);
  const hypothesizers = prompts.filter((item) => item.label.startsWith('hypothesize'));
  assert.equal(hypothesizers.length, 2);
  assert.doesNotMatch(hypothesizers[1].prompt, /Race in session setup hypothesize 1/, 'proposers work blind');
  assert.match(prompts.find((item) => item.label === 'frame hypotheses').prompt, /Race in session setup hypothesize 1[\s\S]*Race in session setup hypothesize 2/);
  assert.match(prompts.find((item) => item.label === 'falsify H2').prompt, /try to REFUTE H2[\s\S]*Rate each one against EVERY hypothesis/);
  const report = state.result;
  assert.match(report, /Most likely cause: \*\*H1: A race in session setup\*\* at 9\d%/);
  assert.match(report, /\| H2: A timezone difference on the runner \| \d+% \| 3 \| refuted: Passes locally with TZ=UTC\. \|/);
  assert.match(report, /O2 \(read, ci\.log; falsifier of H1; non-diagnostic, ignored\)/);
  assert.match(report, /## What would change this conclusion/);
  assert.ok(!prompts.some((item) => item.label.startsWith('discriminate')), 'a clear leader needs no discriminating test');
});

test('diagnose: close leaders get a discriminating test', async () => {
  const prompts = [];
  const overrides = {
    'falsify H1': { verdict: 'weakened', observations: [{ what: 'Fails under load only', how: 'ran', source: 'load test', ratings: r({ H1: '+', H2: '0', H3: '+' }) }] },
    'falsify H2': { verdict: 'refuted', observations: [{ what: 'Passes with TZ=UTC', how: 'ran', source: 'TZ=UTC npm test', ratings: r({ H1: '0', H2: '--', H3: '0' }) }] },
    'falsify H3': { verdict: 'survived', observations: [] },
    'propose tests': { tests: [
      { test: 'Rerun CI', predictions: r({ H1: '+', H2: '+', H3: '+' }) },
      { test: 'Print SESSION_SECRET length on CI', predictions: r({ H1: '+', H2: '+', H3: '--' }) }
    ] },
    'discriminate H1 vs H3': { test: 'Run CI with SESSION_SECRET printed and --runInBand', observations: [{ what: 'SESSION_SECRET is empty on CI', how: 'ran', source: 'ci run 42', ratings: r({ H1: '-', H2: '0', H3: '++' }) }] }
  };
  const state = await runWorkflow({ source: SOURCE, args: { problem: PROBLEM, agents: 2 }, runAgent: scripted(prompts, overrides), structuredRetries: 1 });
  assert.equal(state.status, 'completed', state.error);
  assert.ok(prompts.some((item) => item.label === 'discriminate H1 vs H3'));
  assert.match(prompts.find((item) => item.label === 'propose tests').prompt, /WITHOUT running them yet/);
  assert.match(prompts.find((item) => item.label === 'discriminate H1 vs H3').prompt, /Run this test, chosen because it is expected to separate the hypotheses most \(0\.\d\d bits\): Print SESSION_SECRET length on CI/);
  assert.ok(state.logs.some((line) => /test plan: Print SESSION_SECRET length on CI \(0\.\d\d bits\); Rerun CI \(0\.0\d bits\)/.test(line)), state.logs.join('\n'));
  assert.match(state.result, /## Decisive test\n\nH1 vs H3: Run CI with SESSION_SECRET printed[^\n]*\(chosen over 1 other candidate for the highest expected information, 0\.\d\d bits\)/);
  assert.match(state.result, /\*\*H3: A missing SESSION_SECRET env var on CI\*\*/);
  assert.match(state.result, /Leading explanation \(not settled\)/, 'one direct observation from one agent does not settle it');
});

test('diagnose: when everything is contradicted it looks for the missing explanation', async () => {
  const prompts = [];
  const all = { verdict: 'refuted', observations: [{ what: 'Ruled out', how: 'ran', source: 'x', ratings: r({ H1: '--', H2: '--', H3: '--' }) }] };
  const overrides = { 'falsify H1': all, 'falsify H2': all, 'falsify H3': all, 'find missing hypothesis': { hypothesis: 'A stale cache on the runner', support: 'Clearing the cache fixes it', how: 'ran', source: 'ci run 43' } };
  const state = await runWorkflow({ source: SOURCE, args: PROBLEM, runAgent: scripted(prompts, overrides), structuredRetries: 1 });
  assert.equal(state.status, 'completed', state.error);
  assert.equal(prompts.filter((item) => item.label.startsWith('hypothesize')).length, 3);
  assert.match(state.result, /None of the 3 framed hypotheses survived \(none of these: \d+%\)\. The best remaining explanation[\s\S]*A stale cache on the runner/);
});

test('diagnose: usage without a problem', async () => {
  const state = await runWorkflow({ source: SOURCE, args: '', runAgent: async () => { throw new Error('no agents'); } });
  assert.match(state.result, /^Usage: \/diagnose/);
});

test('diagnose: with no informative candidate the runner designs its own test', async () => {
  const prompts = [];
  const overrides = {
    'falsify H1': { verdict: 'weakened', observations: [{ what: 'Fails under load only', how: 'ran', source: 'load test', ratings: r({ H1: '+', H2: '0', H3: '+' }) }] },
    'falsify H2': { verdict: 'refuted', observations: [{ what: 'Passes with TZ=UTC', how: 'ran', source: 'TZ=UTC npm test', ratings: r({ H1: '0', H2: '--', H3: '0' }) }] },
    'falsify H3': { verdict: 'survived', observations: [] },
    'propose tests': { tests: [{ test: 'Rerun CI', predictions: r({ H1: '+', H2: '+', H3: '+' }) }] },
    'discriminate H1 vs H3': { test: 'Own test', observations: [] }
  };
  const state = await runWorkflow({ source: SOURCE, args: { problem: PROBLEM, agents: 2 }, runAgent: scripted(prompts, overrides), structuredRetries: 1 });
  assert.equal(state.status, 'completed', state.error);
  assert.match(prompts.find((item) => item.label === 'discriminate H1 vs H3').prompt, /Design the single test/);
});
