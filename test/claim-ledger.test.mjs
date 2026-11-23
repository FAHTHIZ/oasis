// The claim ledger (src/claim-ledger.mjs): each checkable statement in a
// result is typed by what backs it, keeps its basis, and is invalidated when
// later evidence undoes it, together with memories saved from it.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { applyClaimInvalidation, buildClaims, claimInvalidationNotice, claimSentences, describeClaimCounts, invalidateClaims, logClaims, restoreClaimLog, settledClaimRevisions } from '../src/claim-ledger.mjs';
import { clearPageStore, rememberPage } from '../src/page-store.mjs';
import { findMemory, runMemoryTool } from '../src/auto-memory.mjs';
import { assessOutcome, deriveTaskSpec } from '../src/task-model.mjs';
import { createSession, runAgentTurn } from '../src/agent.mjs';
import { scriptedModel, toolCall } from './helpers/scripted-model.mjs';

const now = Date.now();
const fetchA = { seq: 1, at: now - 1000, epoch: 0, kind: 'fetch', url: 'https://example.com/a', numbers: ['42.5'], digest: 'a1' };
const fetchB = { seq: 2, at: now - 900, epoch: 0, kind: 'fetch', url: 'https://news.example.org/b', numbers: ['42.5'], digest: 'b1' };
const run = { seq: 3, at: now - 800, epoch: 0, kind: 'execution', numbers: ['0.1234'], finished: true, exitCode: 0, digest: 'e1' };
const check = { seq: 4, at: now - 700, epoch: 0, kind: 'check', command: 'npm test', passed: true, finished: true, exitCode: 0, digest: 'c1' };

test('sentences and list items, without code or headings', () => {
  assert.deepEqual(claimSentences('# Title\n\n- First item here.\n- Second: 3.5% up. Then more text follows.\n\n```js\nconst x = 1;\n```'), ['First item here.', 'Second: 3.5% up.', 'Then more text follows.']);
});

test('claims are typed by footing: observed, calculated, reported, inferred, unverified, contradicted', () => {
  clearPageStore();
  rememberPage('https://example.com/a', 'Output grew 42.5% in 2024, the agency said "demand for storage has never been higher" this year.');
  const text = [
    'The tests pass.',
    'The agency wrote "supply will double next year" ([Agency](https://example.com/a)).',
    'The agency wrote "demand for storage has never been higher" ([Agency](https://example.com/a)).',
    'A figure of 77.7% comes from [Other](https://other.example.net/x).',
    'Output grew 42.5% per [Agency](https://example.com/a) and [News](https://news.example.org/b).',
    'The ratio is 0.1234.',
    'Therefore demand will likely keep rising.',
    'The README is well organized.'
  ].join('\n');
  const { claims, counts } = buildClaims(text, [fetchA, fetchB, run, check], { analysis: true, now });
  const find = (start) => claims.find((claim) => claim.text.startsWith(start));
  const by = new Proxy({}, { get: (_, key) => find(String(key)) });
  assert.equal(by['The tests pass.'].status, 'observed');
  assert.equal(by['Output grew 42.5% '].status, 'reported');
  assert.equal(by['Output grew 42.5% '].independentSources, 2);
  assert.ok(by['Output grew 42.5% '].confidence > 0.55, 'two independent sources raise confidence');
  assert.equal(by['The agency wrote "d'].status, 'reported', 'a verified quote is still only what the page says');
  assert.equal(by['The agency wrote "s'].status, 'contradicted');
  assert.match(by['The agency wrote "s'].reasons[0], /not on https:\/\/example\.com\/a/);
  assert.equal(by['The ratio is 0.1234'].status, 'calculated');
  assert.equal(by['A figure of 77.7% c'].status, 'unverified');
  assert.equal(by['Therefore demand wi'].status, 'inferred');
  assert.ok(by['Therefore demand wi'].dependsOn.length >= 1);
  assert.equal(claims.some((claim) => claim.text.startsWith('The README')), false, 'plain prose is not a claim');
  const shaky = buildClaims('The agency wrote "supply will double next year" ([Agency](https://example.com/a)).\nSo supply is likely rising.', [fetchA]).claims;
  assert.equal(shaky[1].status, 'unverified', 'a conclusion drawn from a contradicted claim');
  assert.match(shaky[1].reasons.join(' '), /builds on a contradicted claim/);
  assert.equal(counts.contradicted, 1);
  assert.match(describeClaimCounts(counts), /1 observed.*1 calculated/);
  for (const claim of claims) assert.ok(Array.isArray(claim.basis));
  assert.equal(by['The ratio is 0.1234'].basis[0].seq, 3, 'the basis names the evidence event');
});

test('a "tests pass" claim against a failed, stale or missing check', () => {
  assert.equal(buildClaims('All tests pass.', []).claims[0].status, 'unverified');
  assert.equal(buildClaims('All tests pass.', [{ ...check, passed: false, exitCode: 1 }]).claims[0].status, 'contradicted');
  const stale = buildClaims('All tests pass.', [check, { seq: 5, kind: 'edit', path: 'a.js' }]).claims[0];
  assert.equal(stale.status, 'unverified');
  assert.match(stale.reasons[0], /files changed after/);
});

test('a page that changes makes claims citing it stale, and their conclusions with them', () => {
  const session = {};
  const { claims } = buildClaims('Output grew 42.5% per [Agency](https://example.com/a).\nSo the market is likely growing.', [fetchA], { now });
  logClaims(session, claims, { task: 'T1' });
  assert.deepEqual(session.claimLog.map((claim) => claim.id), ['C1', 'C2']);
  assert.deepEqual(session.claimLog[1].dependsOn, ['C1']);
  assert.deepEqual(invalidateClaims(session, { ...fetchA, seq: 9, digest: 'a1' }), [], 'the same page again changes nothing');
  const changes = invalidateClaims(session, { ...fetchA, seq: 10, digest: 'a2' });
  assert.deepEqual(changes.map((change) => [change.claim, change.now]), [['C1', 'stale'], ['C2', 'stale']]);
  assert.match(changes[1].reason, /builds on C1/);
});

test('a later failing check contradicts "tests pass" on the same files, but only stales it after edits', () => {
  const same = {};
  logClaims(same, buildClaims('The tests pass.', [check]).claims);
  assert.equal(invalidateClaims(same, { ...check, seq: 8, passed: false, exitCode: 1 })[0].now, 'contradicted');
  const edited = {};
  logClaims(edited, buildClaims('The tests pass.', [check]).claims);
  const [change] = invalidateClaims(edited, { ...check, seq: 8, epoch: 1, passed: false, exitCode: 1 });
  assert.equal(change.now, 'stale');
  assert.equal(change.quiet, true, 'the agent changed the code itself; no reminder needed');
});

test('the log survives a session round-trip with ids continuing', () => {
  const session = {};
  logClaims(session, buildClaims('The tests pass.', [check]).claims);
  const copy = {};
  restoreClaimLog(copy, JSON.parse(JSON.stringify(session.claimLog)));
  logClaims(copy, buildClaims('The ratio is 0.1234.', [run], { analysis: true }).claims);
  assert.deepEqual(copy.claimLog.map((claim) => claim.id), ['C1', 'C2']);
});

test('reported facts from one source are evidence, not verification', () => {
  const spec = deriveTaskSpec('What does the agency report about output growth? Cite the source.');
  const one = assessOutcome(spec, { events: [fetchA], reply: 'Output grew 42.5% per [Agency](https://example.com/a).' });
  assert.equal(one.verdict, 'evidenced');
  assert.equal(one.claims.byStatus.reported, 1);
  const two = assessOutcome(spec, { events: [fetchA, fetchB], reply: 'Output grew 42.5% per [Agency](https://example.com/a) and [News](https://news.example.org/b).' });
  assert.equal(two.verdict, 'verified');
});

test('memories saved from a claim are revised when the claim falls', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-claims-root-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'oasis-claims-home-'));
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(home, { recursive: true, force: true })]));
  const env = { ...process.env, OASIS_CONFIG_DIR: home, HOME: home, OASIS_AUTO_MEMORY: '', OASIS_MEMORY_WRITE_APPROVAL: 'off' };
  const session = { root, sessionId: 's1' };
  logClaims(session, buildClaims('Output grew 42.5% per [Agency](https://example.com/a).\nA figure of 77.7% comes from [Other](https://other.example.net/x).', [fetchA], { now }).claims);
  const saved = await runMemoryTool('memory_save', { name: 'agency output', content: 'Agency output grew 42.5% in 2024.', category: 'reference', evidence: 'https://example.com/a' }, { root, env, session, autoApprove: true });
  assert.deepEqual(saved.claims, ['C1']);
  const weak = await runMemoryTool('memory_save', { name: 'other figure', content: 'A figure of 77.7% comes from the other report.', category: 'reference' }, { root, env, session, autoApprove: true });
  assert.match(String(weak.note), /C2 \(unverified\)/, JSON.stringify(weak));
  const changes = applyClaimInvalidation(session, { ...fetchA, seq: 20, digest: 'changed' }, { env });
  assert.equal(changes[0].claim, 'C1');
  await settledClaimRevisions(session);
  const memory = await findMemory(root, saved.id, { env });
  assert.equal(memory.verificationStatus, 'uncertain');
  assert.match(memory.verificationNote, /C1 .* now stale: https:\/\/example\.com\/a changed since/);
  assert.match(claimInvalidationNotice(session), /C1 .* is now stale/);
  assert.equal(claimInvalidationNotice(session), '', 'told once');
});

test('end to end: a check that fails after "tests pass" reaches the model on its next step', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'oasis-claims-e2e-'));
  const flag = path.join(os.tmpdir(), 'oasis-claims-flag-' + process.pid + '-' + Date.now());
  t.after(() => Promise.all([rm(root, { recursive: true, force: true }), rm(flag, { force: true })]));
  await writeFile(path.join(root, 'package.json'), '{"name":"x","type":"module"}\n');
  await writeFile(path.join(root, 'a.test.mjs'), "import test from 'node:test';\nimport { existsSync } from 'node:fs';\ntest('flag', () => { if (existsSync(" + JSON.stringify(flag) + ")) throw new Error('broken'); });\n");
  const { config, requests } = await scriptedModel(t, [
    toolCall('c1', 'run_command', { command: 'node', args: ['--test', 'a.test.mjs'] }),
    { content: 'The tests pass.' },
    toolCall('c2', 'run_command', { command: 'node', args: ['--test', 'a.test.mjs'] }),
    { content: 'The test now fails; the earlier pass no longer holds.' }
  ]);
  const session = await createSession({ root, config, settings: { permissions: { allow: ['run_command'], ask: [], deny: [] } }, bare: true });
  // The inner `node --test` must not report into this test runner.
  const { NODE_TEST_CONTEXT: _context, ...outer } = process.env;
  const env = { ...outer, OASIS_AGENT_EXPERIENCE: '0', OASIS_NEURON_LEDGER: '0' };
  const first = await runAgentTurn(session, 'Run the tests and tell me if they pass.', { autoApprove: true, approval: async () => true, env });
  assert.equal(first.task.outcome.claims.byStatus.observed, 1, JSON.stringify(first.task.outcome.claims));
  assert.equal(session.claimLog[0].status, 'observed');
  await writeFile(flag, 'x');
  await runAgentTurn(session, 'Run them again.', { autoApprove: true, approval: async () => true, env });
  assert.equal(session.claimLog[0].status, 'contradicted', JSON.stringify(session.evidenceLedger.events.map(({ kind, passed, epoch, seq }) => ({ kind, passed, epoch, seq }))));
  const after = JSON.stringify(requests[3].messages.slice(-2));
  assert.match(after, /Evidence changed under claims made earlier/);
  assert.match(after, /C1 \\"The tests pass.\\" is now contradicted/);
});
