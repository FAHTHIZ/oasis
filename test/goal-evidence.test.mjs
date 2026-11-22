import test from 'node:test';
import assert from 'node:assert/strict';
import { conditionCommands, goalEvidenceGate, goalEvidenceText } from '../src/goal-evidence.mjs';

let seq = 0;
const check = (command, exitCode, extra = {}) => ({ seq: ++seq, kind: 'check', command, exitCode, passed: exitCode === 0, masked: false, ...extra });
const edit = (path = 'src/a.js') => ({ seq: ++seq, kind: 'edit', path });

test('conditionCommands finds named commands', () => {
  assert.deepEqual(conditionCommands('npm test passes'), ['npm test']);
  assert.deepEqual(conditionCommands('`make check` succeeds and cargo test is green'), ['make check', 'cargo test']);
  assert.deepEqual(conditionCommands('the README explains setup'), []);
});

test('a check condition is not met without a passing, current run', () => {
  assert.match(goalEvidenceGate('npm test passes', []).reason, /has not seen `npm test` run/);
  assert.match(goalEvidenceGate('npm test passes', [check('npm test', 1)]).reason, /exited 1/);
  assert.match(goalEvidenceGate('npm test passes', [check('npm test', 0), edit()]).reason, /edited after/);
  assert.match(goalEvidenceGate('npm test passes', [check('npm test | tail', 0, { masked: true, passed: null })]).reason, /pipe/);
  assert.match(goalEvidenceGate('npm test passes', [check('npm run lint', 0)]).reason, /has not seen `npm test`/);
  assert.equal(goalEvidenceGate('npm test passes', [edit(), check('npm test', 0)]).met, true);
  assert.equal(goalEvidenceGate('npm test passes and the CLI prints help', [edit(), check('npm test', 0)]), null);
  assert.equal(goalEvidenceGate('all tests pass', [check('pytest -q', 0)]), null);
  assert.equal(goalEvidenceGate('`npm run test` passes', [check('npm test -- --runInBand', 0)]).met, true);
  assert.match(goalEvidenceGate('all tests pass', []).reason, /a test or build check/);
});

test('conditions that are not about checks go to the judge', () => {
  assert.equal(goalEvidenceGate('the README documents every flag', []), null);
  assert.equal(goalEvidenceGate('the tests fail less often', []), null);
});

test('goalEvidenceText lists what ran', () => {
  const text = goalEvidenceText([check('npm test', 1), edit('src/x.js'), { seq: ++seq, kind: 'command', command: 'ls', exitCode: 0 }]);
  assert.match(text, /check `npm test`: exit 1, files edited after it/);
  assert.match(text, /ran `ls`: exit 0/);
  assert.match(text, /1 file edit in total, last: src\/x.js/);
  assert.match(goalEvidenceText([]), /no commands/);
});

test('the verify agent verdict decides a goal the judge called met', async () => {
  const { parseVerifierResult, goalVerifierEnabled } = await import('../src/goal-evidence.mjs');
  assert.equal(parseVerifierResult({ report: 'PASS a: ran it\nPASS b: ok\nVERDICT: PASS' }).met, true);
  assert.match(parseVerifierResult({ report: 'PASS a\nFAIL b: empty input crashes (node cli.mjs "")\nVERDICT: FAIL' }).reason, /empty input crashes/);
  assert.match(parseVerifierResult({ report: 'Looks good to me.' }).reason, /no verdict/);
  assert.equal(parseVerifierResult({ report: 'FAIL c: missing docs\nVERDICT: PASS' }).met, false);
  assert.equal(parseVerifierResult({ report: 'VERDICT: PASS', unverified_claim: 'no check ran' }).met, false);
  assert.equal(goalVerifierEnabled({ settings: { goalVerifier: 'agent' } }, {}), true);
  assert.equal(goalVerifierEnabled({ settings: { goalVerifier: 'agent' } }, {}, false), false);
  assert.equal(goalVerifierEnabled({}, { OASIS_GOAL_VERIFIER: 'agent' }), true);
  assert.equal(goalVerifierEnabled({}, {}), false);
});

test('a passing run that ran no tests, or only some, does not meet a goal about the suite', async () => {
  const { evidenceFromToolResult } = await import('../src/evidence-ledger.mjs');
  const shell = (command, stdout) => evidenceFromToolResult('run_shell', { command }, { exitCode: 0, stdout }, { isCheck: true, checkKind: 'test' });
  const empty = shell('npm test -- --test-name-pattern zzz', 'ℹ tests 0\nℹ suites 0\nℹ pass 0\nℹ fail 0\n');
  assert.equal(empty.noTests, true);
  assert.equal(empty.filtered, true);
  assert.match(goalEvidenceGate('npm test passes', [{ ...empty, seq: 1 }]).reason, /ran no tests/);
  const some = shell('npm test -- --grep median', '  3 passing (4ms)\n');
  assert.equal(some.noTests, undefined);
  assert.match(goalEvidenceGate('npm test passes', [{ ...some, seq: 1 }]).reason, /selected only some tests/);
  assert.equal(goalEvidenceGate('npm test passes for the tests matching median', [{ ...some, seq: 1 }]), null, 'a goal about a subset accepts a filtered run');
  const full = shell('npm test', '# tests 12\n# pass 12\n# fail 0\n');
  assert.equal(full.noTests, undefined);
  assert.equal(full.filtered, undefined);
  assert.equal(goalEvidenceGate('npm test passes', [{ ...full, seq: 1 }]).met, true);
  assert.equal(shell('cargo test', 'running 0 tests\n\nrunning 0 tests\n').noTests, true);
  assert.equal(shell('cargo test', 'running 0 tests\n\nrunning 4 tests\n').noTests, undefined);
  assert.equal(shell('go test ./...', 'ok  \texample.com/a\t0.1s [no tests to run]\n').noTests, true);
  assert.equal(shell('python -m pytest', '5 passed in 0.1s\n').filtered, undefined, 'python -m is not a filter');
  assert.equal(evidenceFromToolResult('run_shell', { command: 'tsc -t es2022' }, { exitCode: 0, stdout: '' }, { isCheck: true, checkKind: 'type-check' }).filtered, undefined);
  assert.match(goalEvidenceText([{ ...empty, seq: 1 }]), /no tests ran/);
});

test('a PASS from a verifier that read an injection does not count', async () => {
  const { parseVerifierResult } = await import('../src/goal-evidence.mjs');
  assert.equal(parseVerifierResult({ report: '- PASS: ok\nVERDICT: PASS' }).met, true);
  const tainted = parseVerifierResult({ report: '- PASS: ok\nVERDICT: PASS', untrusted_input: 'agent agent_2 read content from fetch_url that looked like a prompt-injection attempt' });
  assert.equal(tainted.met, false);
  assert.match(tainted.reason, /prompt-injection/);
});

test('a condition that is only one check passing is met from the record, without a judge', () => {
  const pass = { kind: 'check', command: 'npm test', passed: true, exitCode: 0, finished: true, seq: 1 };
  assert.equal(goalEvidenceGate('npm test passes', [pass]).met, true);
  assert.equal(goalEvidenceGate('`npm run test` passes.', [pass]).met, true);
  assert.equal(goalEvidenceGate('npm test passes and the README documents the flag', [pass]), null, 'a compound condition still needs judgement');
  assert.equal(goalEvidenceGate('npm test passes', [pass, { kind: 'edit', path: 'a.js', seq: 2 }]).met, false);
});
