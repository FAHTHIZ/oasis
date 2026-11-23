import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createEvidenceLedger, evidenceFromToolResult, evidenceSince, evidenceSummary, fetchedUrls, lastCheck,
  normalizeUrl, numbersIn, producedNumbers, recordEvidence, searchedUrls
} from '../src/evidence-ledger.mjs';
import { analysisContract, checkReport, citedUrls, codeContract, reportedNumbers, researchContract } from '../src/verification-contracts.mjs';

const record = (ledger, name, args, result, context) => recordEvidence(ledger, evidenceFromToolResult(name, args, result, context));

test('events come from tool results only, with digests and sequence numbers', () => {
  const ledger = createEvidenceLedger();
  assert.equal(record(ledger, 'read_file', { path: 'a.js' }, { error: 'not found' }), null, 'a failed read is not evidence');
  assert.equal(record(ledger, 'run_command', { command: 'npm', args: ['test'] }, { approved: false }, { isCheck: true }), null, 'a denied call is not evidence');
  const check = record(ledger, 'run_command', { command: 'npm', args: ['test'] }, { approved: true, exitCode: 0, stdout: 'ok 3' }, { isCheck: true, checkKind: 'test' });
  assert.equal(check.kind, 'check');
  assert.equal(check.passed, true);
  assert.equal(check.seq, 1);
  assert.match(check.digest, /^[0-9a-f]{16}$/);
  const again = evidenceFromToolResult('run_command', { command: 'npm', args: ['test'] }, { approved: true, exitCode: 0, stdout: 'ok 3' }, { isCheck: true });
  assert.equal(again.digest, check.digest, 'same result, same digest');
  // A read records the path only (local sources a research answer rests on).
  const read = record(ledger, 'read_file', { path: 'a.js' }, { path: 'a.js', content: 'x' });
  assert.deepEqual([read.kind, read.path, read.seq, 'content' in read], ['read', 'a.js', 2, false]);
  // The model's own words never reach the ledger: there is no API for them.
  assert.equal(ledger.events.length, 2);
});

test('an edit after a check makes the check stale, like claim-check', () => {
  const ledger = createEvidenceLedger();
  record(ledger, 'run_shell', { command: 'npm test' }, { exitCode: 0 }, { isCheck: true });
  assert.equal(lastCheck(ledger.events).stale, false);
  record(ledger, 'edit_file', { path: 'a.js' }, { path: 'a.js', changed: true }, { edited: true, path: 'a.js' });
  assert.equal(lastCheck(ledger.events).stale, true);
  assert.equal(ledger.epoch, 1);
  record(ledger, 'run_shell', { command: 'npm test | tail' }, { exitCode: 0 }, { isCheck: true, masked: true });
  const masked = lastCheck(ledger.events);
  assert.equal(masked.stale, false);
  assert.equal(masked.passed, null, 'a piped check proves nothing');
  assert.deepEqual(evidenceSummary(ledger.events).counts, { check: 2, edit: 1 });
  assert.deepEqual(evidenceSince(ledger, 2).map((event) => event.kind), ['check']);
});

test('fetches, searches and executions record what they showed', () => {
  const ledger = createEvidenceLedger();
  record(ledger, 'web_search', { query: 'q' }, { results: [{ url: 'https://www.Example.com/a/' }, { url: 'https://b.org/x#frag' }] });
  record(ledger, 'fetch_url', { url: 'https://example.com/a' }, { url: 'https://example.com/a', content: 'Revenue was 1,234.5 million' });
  assert.equal(record(ledger, 'fetch_url', { url: 'https://down.example' }, { url: 'https://down.example', status: 500, error: 'bad' }), null, 'a failed fetch read nothing');
  record(ledger, 'execute_code', {}, { result: { mean: 0.4567 }, logs: ['n=120'] });
  record(ledger, 'run_command', { command: 'python3', args: ['stats.py'] }, { exitCode: 0, stdout: 'median 42' });
  assert.deepEqual([...searchedUrls(ledger.events)], ['https://example.com/a', 'https://b.org/x']);
  assert.deepEqual([...fetchedUrls(ledger.events)], ['https://example.com/a']);
  const numbers = producedNumbers(ledger.events);
  for (const value of ['1234.5', '0.4567', '120', '42']) assert.ok(numbers.has(value), value);
  assert.equal(ledger.events.at(-1).kind, 'execution');
  assert.equal(normalizeUrl('https://x.com/p?utm_source=a&id=2#h'), 'https://x.com/p?id=2');
  assert.deepEqual(numbersIn('a 1,000 b -3.5 c 2e3'), ['1000', '-3.5', '2000']);
});

test('code contract: same answers as the claim check', () => {
  const claim = 'All tests pass.';
  assert.deepEqual(codeContract('I only read files.', []), []);
  assert.match(codeContract(claim, [])[0].reason, /ran no test/);
  const fail = [{ seq: 1, kind: 'check', command: 'npm test', exitCode: 1, passed: false, finished: true, checkKind: 'test' }];
  assert.match(codeContract(claim, fail)[0].reason, /last test command exited with code 1/);
  const pass = [{ seq: 1, kind: 'check', command: 'npm test', exitCode: 0, passed: true, finished: true }];
  assert.deepEqual(codeContract(claim, pass), []);
  assert.match(codeContract(claim, [...pass, { seq: 2, kind: 'edit', path: 'a.js' }])[0].reason, /edited files after/);
  assert.match(codeContract(claim, [{ seq: 1, kind: 'check', command: 'npm test | tail', exitCode: 0, passed: null, masked: true, finished: true }])[0].reason, /hidden by a pipe/);
});

test('research contract: a citation needs a fetch, not just a search hit', () => {
  const events = [
    { kind: 'search', urls: ['https://a.com/one', 'https://b.com/two'] },
    { kind: 'fetch', url: 'https://a.com/one' }
  ];
  assert.deepEqual(citedUrls('See [one](https://a.com/one/) and https://b.com/two.'), ['https://a.com/one', 'https://b.com/two']);
  assert.deepEqual(researchContract('See [one](https://a.com/one).', events), []);
  const issues = researchContract('See [one](https://a.com/one) and [two](https://b.com/two).', events);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].urls, ['https://b.com/two']);
  assert.match(issues[0].reason, /1 only appeared in search results/);
});

test('analysis contract: a number needs an execution that produced it', () => {
  assert.deepEqual(reportedNumbers('In 2024 we had 3 items, version `1.2.3`, mean 0.46, share 45.7%, total 1,234').map((n) => n.raw), ['0.46', '45.7%', '1,234']);
  const events = [{ kind: 'execution', numbers: ['0.4567', '1234'] }];
  assert.deepEqual(analysisContract('Mean 0.46, share 45.7%, total 1,234.', events), []);
  const issues = analysisContract('Mean 0.46 and the p-value is 0.031.', events);
  assert.equal(issues.length, 1);
  assert.deepEqual(issues[0].numbers, ['0.031']);
  // Applies when declared, or when code ran with no test around it.
  assert.deepEqual(checkReport('The p-value is 0.031.', []), []);
  assert.equal(checkReport('The p-value is 0.031.', [], { domains: ['analysis'] })[0].domain, 'analysis');
  assert.equal(checkReport('The p-value is 0.031.', events)[0].domain, 'analysis');
  assert.deepEqual(checkReport('Fixed it in 120 ms.', [...events, { kind: 'check', passed: true, finished: true }]), []);
});
