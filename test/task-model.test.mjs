import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  admitsShortfall,
  assessOutcome, assessRisk, classifyDomains, classifyIntent, declareOnSpec, deriveTaskSpec, lengthLimits, measureText,
  normalizeDomain, outcomeNotice, restoreSpec, specSummary, targetFiles, taskBrief, TASK_SCHEMA_VERSION, unmetCheckable, verdictIsVerified
} from '../src/task-model.mjs';

const kinds = (spec) => spec.acceptance.map((item) => item.kind);
const domains = (spec) => [spec.domains.primary, ...spec.domains.secondary];

test('intake reads intent, domain and complexity across kinds of work', () => {
  const question = deriveTaskSpec('What is a monad?');
  assert.equal(question.intent.kind, 'question');
  assert.equal(question.complexity, 'trivial');
  assert.deepEqual(question.acceptance, [], 'a simple question gets no ceremony');
  assert.equal(question.autonomy.verification, 'none');

  const fix = deriveTaskSpec('Fix the off-by-one bug in src/parser.js and make sure the tests pass.');
  assert.equal(fix.intent.kind, 'change');
  assert.equal(fix.domains.primary, 'software');
  assert.deepEqual(kinds(fix), ['check_passes']);

  const research = deriveTaskSpec('Research the current state of solid-state batteries and write a 500-word summary to report.md with at least two independent sources.');
  assert.equal(research.domains.primary, 'research');
  assert.ok(domains(research).includes('writing'));
  assert.deepEqual(kinds(research), ['file_exists', 'word_limit', 'cites_sources', 'claims_supported']);
  const cites = research.acceptance.find((item) => item.kind === 'cites_sources');
  assert.deepEqual(cites.params, { min: 2, independent: true, target: 'report.md' });
  const words = research.acceptance.find((item) => item.kind === 'word_limit');
  assert.equal(words.params.target, 'report.md', 'the limit applies to the file the user asked for');
  assert.ok(words.params.min < 500 && words.params.max > 500, 'an approximate length gets a tolerance band');

  assert.equal(deriveTaskSpec('Analyze sales.csv and tell me the median order value per region.').domains.primary, 'analysis');
  const letter = deriveTaskSpec('Write a cover letter for a data analyst job, under 300 words.');
  assert.equal(letter.domains.primary, 'writing', '"data analyst" in a writing task does not make it analysis');
  assert.deepEqual(letter.acceptance[0].params, { unit: 'word', max: 300, target: 'reply' });
  assert.equal(deriveTaskSpec('Plan a 5-day trip to Japan in April on a $3000 budget.').intent.kind, 'plan');
  assert.equal(deriveTaskSpec('Open the browser, log in to the dashboard and download the invoice PDF.').domains.primary, 'computer');
  assert.equal(deriveTaskSpec('Audit this repository for security vulnerabilities like SQL injection and XSS.').domains.primary, 'security');
  const automation = deriveTaskSpec('Every morning, collect the top Hacker News stories and post them to Slack.');
  assert.equal(automation.domains.primary, 'automation');
  assert.ok(kinds(automation).includes('side_effect'));
});

test('risk comes from what the task does, and negations do not raise it', () => {
  const deploy = deriveTaskSpec('Deploy the app to production and send an email to the team.');
  assert.equal(deploy.risk.level, 'high');
  assert.ok(deploy.risk.reasons.includes('production'));
  assert.ok(deploy.risk.reasons.includes('external_communication'));
  assert.equal(deploy.autonomy.verification, 'independent', 'high-risk work asks for independent verification');
  assert.equal(assessRisk('Do not delete anything; just list the large files in this folder.').level, 'low');
  assert.equal(assessRisk('Move the helper to utils.js').level, 'low', 'moving code is not a destructive action');
  assert.notEqual(assessRisk('Delete all the old backups from the server').level, 'low');
});

test('classifiers avoid common false positives', () => {
  assert.equal(classifyDomains('Compute the median order value from orders.csv').primary, 'analysis');
  assert.notEqual(classifyIntent('Move the helper function to utils.js'), 'question');
  assert.deepEqual(targetFiles('Write the summary to report.md and save the list as notes/todo.txt'), ['report.md', 'notes/todo.txt']);
  assert.deepEqual(targetFiles('Version 1.2 is out; see e.g. the docs'), []);
  assert.deepEqual(lengthLimits('in at most 3 bullet points'), [{ unit: 'bullet', max: 3 }]);
  assert.deepEqual(lengthLimits('No longer than 200 words'), [{ unit: 'word', max: 200 }]);
  // Regression: the /review prompt's "one- or two-sentence summary" demanded
  // exactly two sentences and flagged "No findings."
  assert.deepEqual(lengthLimits('Then reply with a one- or two-sentence summary instead.'), [{ unit: 'sentence', max: 2 }]);
  for (const [legacy, current] of [['code', 'software'], ['ops', 'operations'], ['review', 'software'], ['', 'general'], ['nonsense', 'general'], ['research', 'research']]) {
    assert.equal(normalizeDomain(legacy), current);
  }
});

test('a continuation keeps the task it continues', () => {
  const first = deriveTaskSpec('Research solar panel efficiency and cite at least two sources.');
  const next = deriveTaskSpec('yes', { previous: first });
  assert.equal(next.id, first.id);
  assert.equal(next.turns, 2);
  assert.deepEqual(kinds(next), kinds(first));
  assert.equal(deriveTaskSpec('yes').complexity, 'trivial', 'with nothing to continue it is just a reply');
  assert.notEqual(deriveTaskSpec('Now write a poem about the sea.', { previous: first }).id, first.id);
});

test('declared criteria are validated and cannot set a status', () => {
  const spec = deriveTaskSpec('Write the onboarding guide.');
  const { spec: next, added, errors } = declareOnSpec(spec, {
    deliverables: [{ kind: 'file', description: 'the guide', path: 'docs/guide.md' }, { description: 'escape', path: '../outside.md' }],
    acceptance: [
      { kind: 'word_limit', description: 'short', max: 800, path: 'docs/guide.md', status: 'met' },
      { kind: 'word_limit', description: 'no bounds' },
      { kind: 'file_exists', description: 'abs', path: '/etc/passwd' },
      { kind: 'word_limit', description: 'escape', max: 10, path: '../x.md' },
      { kind: 'made_up', description: 'a person judges tone' }
    ],
    constraints: ['plain English']
  });
  assert.equal(errors.length, 4);
  assert.ok(next.acceptance.every((item) => item.status === 'open'), 'the model cannot mark criteria met');
  assert.ok(next.acceptance.some((item) => item.kind === 'file_exists' && item.params.path === 'docs/guide.md'), 'a file deliverable implies a file check');
  assert.equal(next.acceptance.find((item) => item.description === 'a person judges tone').kind, 'manual');
  assert.ok(added.length >= 3);
  assert.deepEqual(next.constraints.slice(-1), ['plain English']);
  assert.equal(spec.acceptance.length, 0, 'declaring returns a new spec');
});

test('measureText counts what limits refer to', () => {
  const counts = measureText('# Title\n\nOne two three. Four five!\n\n- a\n- b\n\n```\ncode words here\n```');
  assert.equal(counts.word, 7);
  assert.equal(counts.bullet, 2);
  assert.equal(counts.sentence, 2);
});

async function workspace(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'oasis-task-model-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

test('acceptance is evaluated against tool results, not the reply', async (t) => {
  const root = await workspace(t);
  const fix = deriveTaskSpec('Fix the parser bug and make sure the tests pass.');
  const pass = { seq: 2, kind: 'check', command: 'npm test', finished: true, passed: true, exitCode: 0 };
  const verdict = (events, reply = 'Fixed. All tests pass.') => assessOutcome(fix, { events, reply, root });
  assert.equal(verdict([]).verdict, 'rejected', 'claiming tests pass with no check is rejected');
  assert.equal(verdict([], 'I changed the loop bound.').acceptance.criteria[0].status, 'unmet');
  assert.equal(verdict([{ seq: 1, kind: 'edit', path: 'a.js' }, pass]).verdict, 'verified');
  assert.equal(verdict([pass, { seq: 3, kind: 'edit', path: 'a.js' }]).acceptance.criteria[0].detail, 'files changed after `npm test` passed');
  assert.equal(verdict([{ ...pass, passed: false, exitCode: 1 }]).verdict, 'rejected');
  assert.equal(verdict([{ ...pass, masked: true, passed: null }]).acceptance.unmet, 1, 'a piped exit status is not a pass');

  const report = deriveTaskSpec('Write a 100-word summary to notes.md citing at least one source.');
  const fetched = [{ seq: 1, kind: 'fetch', url: 'https://example.org/a' }];
  const reply = 'Summary written. Source: https://example.org/a';
  assert.equal(assessOutcome(report, { events: fetched, reply, root }).acceptance.criteria.find((c) => c.kind === 'file_exists').status, 'unmet');
  await writeFile(path.join(root, 'notes.md'), Array.from({ length: 100 }, (_, i) => 'w' + i).join(' '));
  const done = assessOutcome(report, { events: fetched, reply, root });
  assert.equal(done.acceptance.unmet, 0, JSON.stringify(done.acceptance.criteria));
  // Every criterion met, but the content rests on one page as read: the
  // attribution is checked, the facts are not (claim ledger: reported).
  assert.equal(done.verdict, 'evidenced');
  assert.equal(verdictIsVerified(done.verdict), false);
  const unread = assessOutcome(report, { events: [], reply, root });
  assert.equal(unread.verdict, 'rejected', 'citing a page that was never fetched is rejected');
  assert.ok(unmetCheckable(unread).length >= 1);
  assert.match(outcomeNotice(unread), /never fetched|cites no sources|not met/i);
});

test('tool activity alone does not verify anything', () => {
  const spec = deriveTaskSpec('Find out what the population of Lisbon is.');
  const outcome = assessOutcome(spec, { events: [{ seq: 1, kind: 'fetch', url: 'https://example.org/lisbon' }, { seq: 2, kind: 'execution', exitCode: 0, finished: true, numbers: [] }], reply: 'About half a million people.' });
  assert.equal(outcome.verdict, 'unverified');
  assert.equal(verdictIsVerified(outcome.verdict), false);

  const action = deriveTaskSpec('Install the dependencies and commit the lockfile.');
  const ran = assessOutcome(action, { events: [{ seq: 1, kind: 'command', exitCode: 0 }], reply: 'Done.' });
  const effect = ran.acceptance.criteria.find((c) => c.kind === 'side_effect');
  assert.equal(effect.status, 'unknown', 'a command that exited 0 is not proof the action happened');
  assert.equal(assessOutcome(action, { events: [{ seq: 1, kind: 'side_effect', tool: 'git_commit' }], reply: 'Done.' }).acceptance.criteria.find((c) => c.kind === 'side_effect').status, 'met');
});

test('the verdict ladder keeps execution, evidence, acceptance and review separate', () => {
  const spec = deriveTaskSpec('Fix the parser bug and make sure the tests pass.');
  const pass = [{ seq: 1, kind: 'edit', path: 'a.js' }, { seq: 2, kind: 'check', command: 'npm test', finished: true, passed: true, exitCode: 0 }];
  assert.equal(assessOutcome(spec, { status: 'failed' }).verdict, 'failed');
  assert.equal(assessOutcome(spec, { status: 'cancelled' }).verdict, 'cancelled');
  assert.equal(assessOutcome(spec, { partial: true, events: pass }).verdict, 'incomplete');
  assert.equal(assessOutcome(spec, { events: pass, reply: 'Tests pass.', reviews: [{ by: 'code-review', verdict: 'pass' }] }).verdict, 'independently_verified');
  const failedReview = assessOutcome(spec, { events: pass, reply: 'Tests pass.', reviews: [{ by: 'code-review', verdict: 'fail', detail: 'misses the empty-input case' }] });
  assert.equal(failedReview.verdict, 'rejected');
  assert.equal(failedReview.execution, 'completed');
  assert.equal(failedReview.independent.passed, false);
  const manual = declareOnSpec(spec, { acceptance: [{ kind: 'manual', description: 'the maintainer likes the API' }] }).spec;
  assert.equal(assessOutcome(manual, { events: pass, reply: 'Tests pass.' }).verdict, 'evidenced', 'a criterion only a person can judge stops short of verified');
});

test('the brief, summary and restore round-trip', () => {
  const spec = deriveTaskSpec('Research heat pumps and write a 300-word report to heat.md with two independent sources.');
  const brief = taskBrief(spec);
  assert.match(brief, /^<task-contract id="/);
  assert.match(brief, /you cannot mark them met/);
  assert.equal(taskBrief(deriveTaskSpec('hi')), '', 'trivial tasks get no brief');
  const summary = specSummary({ ...spec, outcome: assessOutcome(spec, {}) });
  assert.equal(summary.outcome.verdict, 'rejected');
  assert.equal(restoreSpec(JSON.parse(JSON.stringify(spec))).id, spec.id);
  assert.equal(restoreSpec({ schemaVersion: TASK_SCHEMA_VERSION + 1 }), null);
  assert.equal(restoreSpec('junk'), null);
});

test('an answer that admits the shortfall is not nudged as a false success', () => {
  assert.equal(admitsShortfall('Could not write.'), true);
  assert.equal(admitsShortfall("I wasn't able to fetch the page, so the summary is missing."), true);
  assert.equal(admitsShortfall('Wrote a.txt with the summary.'), false);
});

test('token-usage work is not a credentials risk, and standing-rule-only tasks get no brief', () => {
  const spec = deriveTaskSpec('Fix normalizeUsage so token usage counts cache tokens, and add a test.');
  assert.ok(!spec.risk.reasons.includes('credentials'));
  assert.equal(deriveTaskSpec('Rotate the GitHub token in .env').risk.reasons.includes('credentials'), true);
  assert.equal(taskBrief(spec), '');
});
