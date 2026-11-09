// Claim check: a final reply that says the tests/build pass must agree with
// what actually ran in this turn. Users report agents announcing "all tests
// pass" right after a failing run, after editing again, or from a piped
// command whose real exit status was hidden. One reconcile nudge per turn.

const POSITIVE = [
  /\b(?:all|the|every|both)?\s*(?:unit |integration |e2e )?(?:tests?|specs?|test suite|checks?|builds?|lint(?:ing)?|type-?checks?)\s+(?:now\s+|all\s+|still\s+)?(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|(?:is|are)\s+(?:passing|green|clean))\b/i,
  /\b(?:tests?|suite|build|ci)\b[^.\n]{0,20}\b(?:green|all green)\b/i,
  /\ball\s+\d+\s+tests?\s+pass/i,
  /\b\d+\s+(?:tests?\s+)?pass(?:ed|ing)?,?\s+0\s+fail/i,
  /\bbuild (?:is )?(?:successful|succeeds|succeeded)\b/i,
  /✅\s*(?:all )?tests?/i
];
const NEGATION = /\b(?:fail(?:s|ed|ing|ures?)?|not (?:all )?pass|don'?t pass|doesn'?t pass|didn'?t pass|could ?n[o']t (?:run|verify)|unable to (?:run|verify)|broken|still red|errors? remain)\b/i;

export function claimsPassing(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  if (!POSITIVE.some((pattern) => pattern.test(value))) return false;
  return !NEGATION.test(value.replace(/\b(?:0|zero|no)\s+(?:tests?\s+)?fail(?:ed|ures?|ing|s)?\b/gi, ''));
}

export function newClaimState() {
  return { ran: 0, lastExit: null, lastCommand: '', editedAfter: false, masked: false, unfinished: false, nudged: false };
}

export function recordCheck(state, { command, exitCode, masked = false }) {
  if (!state) return;
  state.ran += 1;
  state.lastCommand = String(command || '').slice(0, 200);
  state.masked = Boolean(masked);
  state.lastExit = masked ? null : (Number.isInteger(exitCode) ? exitCode : null);
  // No exit code: it timed out, was stopped, or moved to the background.
  state.unfinished = !masked && !Number.isInteger(exitCode);
  state.editedAfter = false;
}

export function recordEdit(state) {
  if (state && state.ran) state.editedAfter = true;
}

// Returns a nudge string when the reply claims success the turn does not support.
export function claimIssue(state, text, { edited = false, deniedCheck = '' } = {}) {
  if (!state || state.nudged || !claimsPassing(text)) return '';
  // Code changed and the reply reports passing checks, but no check ran at
  // all: the result can only have been made up.
  if (!state.ran) {
    if (!edited) return '';
    state.nudged = true;
    return 'Your reply says the checks pass, but no test, check or build command ran in this turn' +
      (deniedCheck ? ' (`' + deniedCheck + '` was not approved, so it cannot run)' : '') +
      '. Never write test or command output you did not see in a tool result. Rewrite the answer: say what changed, say plainly that the checks were not run, and give the user the exact command to run.';
  }
  let problem = '';
  if (state.masked) problem = 'the latest check (`' + state.lastCommand + '`) had its exit status hidden by a pipe, so it proves nothing';
  else if (state.unfinished) problem = 'the latest check (`' + state.lastCommand + '`) did not finish (it timed out, was stopped or is still running), so it proves nothing';
  else if (Number.isInteger(state.lastExit) && state.lastExit !== 0) problem = 'the latest check (`' + state.lastCommand + '`) exited with code ' + state.lastExit;
  else if (state.editedAfter) problem = 'files were edited after the latest check (`' + state.lastCommand + '`), so its result is stale';
  if (!problem) return '';
  state.nudged = true;
  return 'Your reply says the checks pass, but ' + problem + '. Do not report success that the tool results do not show. ' +
    'Rerun the relevant check now (without piping away its exit status) and report the actual outcome; if it still fails, say so plainly and explain what remains.';
}

const NO_CHECK = /no relevant test, check, lint, build, or type-check command has passed/;

/**
 * The gate already sent the reply back once and checks are still missing.
 * The user must not leave thinking the change was verified, so the runtime
 * (not the model) adds one plain sentence saying what was not checked.
 */
const ADMITS_UNVERIFIED = /\b(not (been )?(approved|run|executed|verified)|wasn't (approved|run)|was not (approved|run)|did not run|didn't run|no (lint, build, or )?test(s)? (run|were run)|could not run|couldn't run|unverified)\b/i;

export function appendUnverifiedNotice(text, issues, verification = {}, state = null) {
  const value = String(text || '');
  if (!Array.isArray(issues) || !issues.some((issue) => NO_CHECK.test(issue))) return value;
  const denied = verification && verification.deniedCheck ? String(verification.deniedCheck) : '';
  const failed = state && state.ran && Number.isInteger(state.lastExit) && state.lastExit !== 0 && !state.editedAfter;
  const stale = state && state.ran && state.editedAfter;
  let reason;
  if (failed) reason = 'the last check (`' + state.lastCommand + '`) failed with exit code ' + state.lastExit;
  else if (stale) reason = 'files changed after the last check (`' + state.lastCommand + '`) ran';
  else if (denied) reason = '`' + denied + '` was not approved, so no check ran';
  else reason = 'no test or check command ran after the last edit';
  const claimed = claimsPassing(value) && !failed;
  const command = denied || (state && state.lastCommand) || '';
  const note = 'Not verified: ' + reason + '.' + (claimed ? ' Any passing test results described above were not observed by OASIS.' : '') + (command && !failed ? ' Run `' + command + '` to confirm.' : '');
  if (value.includes('Not verified: ')) return value;
  // The answer already admits the check did not run and makes no passing claim: no need to repeat it.
  if (!claimed && !failed && !stale && ADMITS_UNVERIFIED.test(value)) return value;
  return (value.trim() ? value.replace(/\s+$/, '') + '\n\n' : '') + note;
}
