import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { reportFindings, formatFindings } from '../src/session-tools.mjs';
import { runHeadless } from '../src/headless.mjs';
import { reviewPrompt } from '../src/slash.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

test('report_findings validates, dedupes and sorts by severity', () => {
  const session = {};
  reportFindings(session, { findings: [
    { file: 'a.js', line: 3, summary: 'off by one', failure_scenario: 'empty list', severity: 'low' },
    { file: 'b.js', line: 9, summary: 'null deref', failure_scenario: 'missing user', severity: 'critical', category: 'Correctness', fix: 'guard' }
  ], summary: 'Two bugs.' });
  const again = reportFindings(session, { findings: [{ file: 'a.js', line: 3, summary: 'off by one', failure_scenario: 'x' }] });
  assert.equal(again.recorded, 0);
  assert.deepEqual(session.reportedFindings.map((f) => f.file), ['b.js', 'a.js']);
  assert.equal(session.reportedFindings[0].category, 'correctness');
  assert.equal(session.findingsSummary, 'Two bugs.');
  assert.throws(() => reportFindings(session, { findings: [{ line: 1 }] }), /file and summary/);
  const text = formatFindings(session.reportedFindings);
  assert.match(text, /1\. \[critical \/ correctness\] b\.js:9 - null deref\n   When: missing user\n   Fix: guard/);
  assert.equal(formatFindings([]), 'No findings.');
});

test('review prompts ask for report_findings', () => {
  assert.match(reviewPrompt('review', 'high'), /report_findings/);
});

test('headless JSON results carry reported findings', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-rf-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const { config, requests } = await scriptedModel(t, [
    toolCall('r1', 'report_findings', { findings: [{ file: 'x.js', line: 2, summary: 'leak', failure_scenario: 'many calls', severity: 'high' }], summary: 'One leak.' }),
    { content: 'Found one leak.' }
  ]);
  let out = '';
  const { summary } = await runHeadless({ root, config, prompt: 'review', outputFormat: 'json', write: (chunk) => { out += chunk; }, sessionOptions: { settings: { permissions: { allow: [], ask: [], deny: [], defaultMode: 'default' }, hooks: {}, sandbox: { enabled: false }, shell: { enabled: false } } } });
  assert.ok(requests[0].tools.some((tool) => tool.function.name === 'report_findings'));
  assert.equal(summary.findings.length, 1);
  assert.equal(summary.findings[0].severity, 'high');
  assert.equal(summary.findings_summary, 'One leak.');
  assert.match(out, /"findings":\[/);
});
