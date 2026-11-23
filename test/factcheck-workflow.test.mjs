import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { loadWorkflows, runWorkflow } from '../src/workflows.mjs';
import { loadCustomCommands } from '../src/commands.mjs';

const SOURCE = await readFile(new URL('../src/workflows/factcheck.js', import.meta.url), 'utf8');
const env = { ...process.env, HOME: os.tmpdir(), OASIS_CONFIG_DIR: os.tmpdir() + '/none' };

// An article on news.example.com with four claims.
function scripted(prompts, overrides = {}) {
  return async ({ prompt, label }) => {
    prompts.push({ label, prompt });
    if (overrides[label]) return JSON.stringify(overrides[label]);
    if (label === 'extract claims') return JSON.stringify({ title: 'City budget story', claims: [
      { claim: 'The city budget rose 12% in 2025.', excerpt: 'The budget rose 12% last year.', kind: 'number', checkworthiness: 0.9 },
      { claim: 'The mayor said "we will cut taxes".', excerpt: 'The mayor said "we will cut taxes".', kind: 'attribution', checkworthiness: 0.6 },
      { claim: 'The city has 2 million residents.', kind: 'number', checkworthiness: 0.4 },
      { claim: 'The new library opened in March 2025.', kind: 'date', checkworthiness: 0.3 },
      { claim: 'the city budget rose 12% in 2025', kind: 'number', checkworthiness: 0.2 },
      { claim: 'Crime fell after the new policing policy.', kind: 'causal', checkworthiness: 0.1 }
    ], not_checkable: ['The budget is a good one.'] });
    if (label === 'check C1') return JSON.stringify({ verdict: 'mostly-true', confidence: 0.8, note: 'The budget rose 11.6%.', correction: 'It rose 11.6%, rounded to 12%.', evidence: [{ url: 'https://finance.city.gov/budget-2025', quote: 'an increase of 11.6 percent', stance: 'supports' }, { url: 'https://news.example.com/other', quote: 'up 12%', stance: 'supports' }] });
    if (label === 'check C2') return JSON.stringify({ verdict: 'true', confidence: 0.9, note: 'Only the article itself reports the quote.', evidence: [{ url: 'https://archive.example.com/story', quote: 'we will cut taxes', stance: 'supports' }] });
    if (label === 'check C3') return JSON.stringify({ verdict: 'false', confidence: 0.85, note: 'The census counts 1.4 million.', correction: 'About 1.4 million residents (2020 census).', evidence: [{ url: 'https://census.example.org/city', quote: 'population 1,412,000', stance: 'refutes' }] });
    if (label === 'check C4') return JSON.stringify({ verdict: 'true', confidence: 0.9, note: 'Opened 14 March 2025.', evidence: [{ url: 'https://library.example.net/news', quote: 'opened its doors on 14 March 2025', stance: 'supports' }] });
    if (label === 'check C5') return JSON.stringify({ verdict: 'unverifiable', confidence: 0.3, note: 'No data on causation.' });
    if (label === 'challenge C1') return JSON.stringify({ strength: 'none', note: 'The budget document confirms 11.6%.' });
    if (label === 'challenge C3') return JSON.stringify({ strength: 'weak', note: 'A 2024 estimate is higher, 1.5 million; still not 2 million.' });
    if (label === 'challenge C4') return JSON.stringify({ strength: 'strong', verdict: 'false', note: 'The opening was postponed to April; the March date was the planned one.', evidence: [{ url: 'https://citycouncil.example.org/minutes', quote: 'opening postponed to 9 April', stance: 'refutes' }] });
    throw new Error('unexpected agent ' + label);
  };
}

test('factcheck: extract, independent checks without the original source, adversarial review, verdict table', async () => {
  const prompts = [];
  const state = await runWorkflow({ source: SOURCE, args: 'https://news.example.com/budget --max 5', runAgent: scripted(prompts), structuredRetries: 1 });
  assert.equal(state.status, 'completed', state.error);
  const report = state.result;
  assert.deepEqual(state.phases.map((phase) => phase.title), ['Extract', 'Check', 'Challenge', 'Verdicts']);
  // Duplicates are dropped, claims ranked by checkworthiness and capped at --max.
  assert.deepEqual(prompts.filter((item) => item.label.startsWith('check')).map((item) => item.label), ['check C1', 'check C2', 'check C3', 'check C4', 'check C5']);
  assert.match(prompts[0].prompt, /the web page https:\/\/news\.example\.com\/budget \(fetch it with fetch_url\)/);
  // Each checker sees only its own claim and is told the original site does not count.
  const checker = prompts.find((item) => item.label === 'check C1').prompt;
  assert.match(checker, /anything else on example\.com, does not count as evidence/);
  assert.doesNotMatch(checker, /2 million residents/);
  // Evidence from the original site is discounted; a verdict left with none becomes unverifiable.
  assert.match(report, /\| C1 \| The city budget rose 12% in 2025\. \| mostly-true \| 80% \| \[finance\.city\.gov\]\(https:\/\/finance\.city\.gov\/budget-2025\) \|/);
  assert.match(report, /\| C2 \| .* \| unverifiable \| - \| none \|/, 'archive.example.com is the original site too');
  assert.match(report, /C2 \(attribution\): Downgraded from true: no independent evidence behind it \(only the original source\)/);
  // The challenger: none holds, weak caps confidence, strong + evidence disputes.
  assert.match(report, /\| C3 \| .* \| false \| 60% \|/);
  assert.match(report, /\| C4 \| .* \| disputed \(checker: true, reviewer: false\) \|/);
  assert.match(report, /## Disputed[\s\S]*C4: checker said true .* reviewer said false \(The opening was postponed/);
  assert.ok(!prompts.some((item) => item.label === 'challenge C2' || item.label === 'challenge C5'), 'unverifiable verdicts are not challenged');
  assert.match(report, /## Corrections\n\n- C1: It rose 11\.6%, rounded to 12%\.\n- C3: About 1\.4 million/);
  // Reliability over checkable verdicts, weighted: C1 0.9*0.8, C3 0.4*0 -> 0.72/1.3 = 55%.
  assert.match(report, /5 claims checked: 1 mostly-true, 1 false, 1 disputed, 2 unverifiable\. Weighted reliability of what could be checked: 55%\./);
  assert.match(report, /## Not checkable[\s\S]*- The budget is a good one\./);
});

test('factcheck: inline text and files are read in place; usage and empty results', async () => {
  const prompts = [];
  const none = { 'extract claims': { claims: [], not_checkable: ['Cats are better than dogs.'] } };
  const text = await runWorkflow({ source: SOURCE, args: 'Cats are better than dogs, everyone agrees.', runAgent: scripted(prompts, none), structuredRetries: 1 });
  assert.match(prompts[0].prompt, /Text:\n"""\nCats are better than dogs/);
  assert.match(text.result, /No checkable factual claims found\.[\s\S]*Cats are better than dogs\./);
  const file = await runWorkflow({ source: SOURCE, args: 'docs/report.md', runAgent: scripted(prompts, none), structuredRetries: 1 });
  assert.equal(file.status, 'completed');
  assert.match(prompts[1].prompt, /the file docs\/report\.md \(read it\)/);
  const usage = await runWorkflow({ source: SOURCE, args: '', runAgent: scripted(prompts) });
  assert.match(usage.result, /^Usage: \/factcheck/);
});

test('factcheck is a built-in workflow and therefore the /factcheck command', async () => {
  const workflows = await loadWorkflows(os.tmpdir(), { env });
  assert.equal(workflows.get('factcheck').scope, 'builtin');
  const commands = await loadCustomCommands(os.tmpdir(), { env });
  assert.ok(commands.get('factcheck').workflow);
});
