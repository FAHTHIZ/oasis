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
  return { ran: 0, lastExit: null, lastCommand: '', editedAfter: false, masked: false, nudged: false };
}

export function recordCheck(state, { command, exitCode, masked = false }) {
  if (!state) return;
  state.ran += 1;
  state.lastCommand = String(command || '').slice(0, 200);
  state.masked = Boolean(masked);
  state.lastExit = masked ? null : (Number.isInteger(exitCode) ? exitCode : null);
  state.editedAfter = false;
}

export function recordEdit(state) {
  if (state && state.ran) state.editedAfter = true;
}

// Returns a nudge string when the reply claims success the turn does not support.
export function claimIssue(state, text) {
  if (!state || state.nudged || !state.ran || !claimsPassing(text)) return '';
  let problem = '';
  if (state.masked) problem = 'the latest check (`' + state.lastCommand + '`) had its exit status hidden by a pipe, so it proves nothing';
  else if (Number.isInteger(state.lastExit) && state.lastExit !== 0) problem = 'the latest check (`' + state.lastCommand + '`) exited with code ' + state.lastExit;
  else if (state.editedAfter) problem = 'files were edited after the latest check (`' + state.lastCommand + '`), so its result is stale';
  if (!problem) return '';
  state.nudged = true;
  return 'Your reply says the checks pass, but ' + problem + '. Do not report success that the tool results do not show. ' +
    'Rerun the relevant check now (without piping away its exit status) and report the actual outcome; if it still fails, say so plainly and explain what remains.';
}
