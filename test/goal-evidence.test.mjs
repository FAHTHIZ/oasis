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
  assert.equal(goalEvidenceGate('npm test passes', [edit(), check('npm test', 0)]), null);
  assert.equal(goalEvidenceGate('all tests pass', [check('pytest -q', 0)]), null);
  assert.equal(goalEvidenceGate('`npm run test` passes', [check('npm test -- --runInBand', 0)]), null);
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
