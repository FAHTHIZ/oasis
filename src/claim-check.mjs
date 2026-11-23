// Claim check: a final reply that says the tests/build pass must agree with
// what actually ran in this turn. Users report agents announcing "all tests
// pass" right after a failing run, after editing again, or from a piped
// command whose real exit status was hidden. One reconcile nudge per turn.

import { replyLanguage, notePhrase, noteLabel, noteEnd, hasNote } from './runtime-notes.mjs';
import { multilingualClaimsPassing, multilingualAdmitsUnverified, multilingualClaimsChange, multilingualAdmitsFailure } from './multilingual-signals.mjs';

const POSITIVE = [
  /\b(?:all|the|every|both)?\s*(?:unit |integration |e2e )?(?:tests?|specs?|test suite|checks?|builds?|lint(?:ing)?|type-?checks?)\s+(?:now\s+|all\s+|still\s+)?(?:pass(?:es|ed|ing)?|succeed(?:s|ed)?|(?:is|are)\s+(?:passing|green|clean))\b/i,
  /\b(?:tests?|suite|build|ci)\b[^.\n]{0,20}\b(?:green|all green)\b/i,
  /\ball\s+\d+\s+tests?\s+pass/i,
  /\b\d+\s+(?:tests?\s+)?pass(?:ed|ing)?,?\s+0\s+fail/i,
  /\bbuild (?:is )?(?:successful|succeeds|succeeded)\b/i,
  /✅\s*(?:all )?tests?/i,
  // "The `test` command was run to verify add(), and it passed." (seen from a small local model after a failing run)
  /\b(?:tests?|specs?|checks?|builds?|test suite|npm test|pytest|cargo test|go test)\b[^.\n]{0,120}?\b(?:and|so|which|where)\s+(?:it|they|everything)\s+(?:all\s+)?(?:pass(?:es|ed)?|succeed(?:s|ed)?|work(?:s|ed)?)\b/i
];
const NEGATION = /\b(?:fail(?:s|ed|ing|ures?)?|not (?:all )?pass|don'?t pass|doesn'?t pass|didn'?t pass|could ?n[o']t (?:run|verify)|unable to (?:run|verify)|broken|still red|errors? remain)\b/i;

export function claimsPassing(text) {
  const value = String(text || '');
  if (!value.trim()) return false;
  const negation = NEGATION.test(value.replace(/\b(?:0|zero|no)\s+(?:tests?\s+)?fail(?:ed|ures?|ing|s)?\b/gi, ''));
  // Replies in other languages make the same claims (src/multilingual-signals.mjs).
  if (!POSITIVE.some((pattern) => pattern.test(value))) return !negation && multilingualClaimsPassing(value);
  return !NEGATION.test(value.replace(/\b(?:0|zero|no)\s+(?:tests?\s+)?fail(?:ed|ures?|ing|s)?\b/gi, ''));
}

export function newClaimState() {
  return { ran: 0, lastExit: null, lastCommand: '', editedAfter: false, masked: false, unfinished: false, nudged: false, failedEdits: new Map(), editNudged: false };
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
  // The note is written in the reply's language (src/runtime-notes.mjs).
  const lang = replyLanguage(value);
  const gap = lang === 'zh' || lang === 'ja' ? '' : ' ';
  let reason;
  if (failed) reason = notePhrase(lang, 'failed', { c: state.lastCommand, n: state.lastExit });
  else if (stale) reason = notePhrase(lang, 'stale', { c: state.lastCommand });
  else if (denied) reason = notePhrase(lang, 'denied', { c: denied });
  else reason = notePhrase(lang, 'noCheck');
  const claimed = claimsPassing(value);
  const command = denied || (state && state.lastCommand) || '';
  // A reply that reports a pass after OASIS saw the check fail is the case users most need flagged.
  const contradiction = claimed ? gap + notePhrase(lang, failed ? 'saidPassed' : 'notObserved') : '';
  const note = noteLabel(lang, 'verified') + reason + noteEnd(lang) + contradiction + (command && !failed ? gap + notePhrase(lang, 'run', { c: command }) : '');
  if (hasNote(value, 'verified')) return value;
  // The answer already admits the check did not run and makes no passing claim: no need to repeat it.
  if (!claimed && !failed && !stale && (ADMITS_UNVERIFIED.test(value) || multilingualAdmitsUnverified(value))) return value;
  return (value.trim() ? value.replace(/\s+$/, '') + '\n\n' : '') + note;
}

// Failed edits: a reply must not say "Updated notes.txt." when the write to
// notes.txt failed and was never retried successfully (seen live: write_file
// failed with "File has not been read yet" and the model reported success).
const pathKey = (value) => String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
const baseName = (value) => pathKey(value).split('/').pop();

export function recordEditFailure(state, { path, error }) {
  if (!state || !path) return;
  (state.failedEdits ||= new Map()).set(pathKey(path), String(error || 'the edit failed').split('\n')[0].slice(0, 200));
}

// A later successful edit of the same file settles an earlier failure.
export function recordEditSuccess(state, path) {
  if (state && state.failedEdits && path) state.failedEdits.delete(pathKey(path));
}

const ADMITS_FAILURE = /\b(?:could ?n[o']t|can ?not|cannot|unable to|failed|fail(?:s|ure)|did ?n[o']t|was ?n[o']t|not (?:been )?(?:applied|changed|updated|written|saved|edited|modified)|no changes?|error)\b/i;
const CLAIMS_CHANGE = /\b(?:updated|changed|edited|modified|wrote|written|created|added|fixed|replaced|renamed|saved|applied|implemented|rewrote|appended|inserted)\b/i;

function unsettled(state, text) {
  if (!state || !state.failedEdits || !state.failedEdits.size) return [];
  const value = String(text || '');
  return [...state.failedEdits].filter(([file]) => {
    const name = baseName(file);
    if (!name || !value.includes(name)) return false;
    // Only sentences that name the file count; one that admits the failure settles it.
    const sentences = value.split(/(?<=[.!?])\s+|(?<=[。！？।])\s*|\n+/u).filter((sentence) => sentence.includes(name));
    return sentences.some((sentence) => CLAIMS_CHANGE.test(sentence) || multilingualClaimsChange(sentence)) && !sentences.some((sentence) => ADMITS_FAILURE.test(sentence) || multilingualAdmitsFailure(sentence));
  });
}

// One nudge per turn when the reply claims a change that did not apply.
export function failedEditIssue(state, text) {
  if (!state || state.editNudged) return '';
  const files = unsettled(state, text);
  if (!files.length) return '';
  state.editNudged = true;
  return 'Your reply says ' + files.map(([file]) => file).join(', ') + ' changed, but ' + (files.length === 1 ? 'that edit' : 'those edits') + ' failed: ' +
    files.map(([file, error]) => file + ' (' + error + ')').join('; ') + '. The file is unchanged. Fix the cause and redo the edit (for example, read the file first), or tell the user plainly that the change was not made.';
}

// After the nudge, the runtime itself says what did not apply.
export function appendFailedEditNotice(text, state) {
  const value = String(text || '');
  const files = unsettled(state, value);
  if (!files.length || hasNote(value, 'done')) return value;
  const lang = replyLanguage(value);
  const note = files.map(([file, error]) => noteLabel(lang, 'done') + notePhrase(lang, 'notApplied', { f: file, e: error }) + noteEnd(lang)).join('\n');
  return (value.trim() ? value.replace(/\s+$/, '') + '\n\n' : '') + note;
}

const STALE_CHECK = /has passed after the latest code edit/;

/**
 * Return-time check of a subagent's report (roadmap P1.7). The parent reads
 * only the child's final text, so a report saying the tests pass is checked
 * against what the child's own turn recorded: a check must have run, the
 * last one must have passed, and no edit may have come after it. Returns the
 * reason when the claim is not supported, or '' when it is (or when the
 * report makes no passing claim).
 */
export function unsupportedChildClaim(outcome) {
  if (!outcome || !claimsPassing(outcome.text)) return '';
  const verification = outcome.verification || {};
  const last = verification.lastCheck;
  if (!last) return 'the report says checks pass, but the agent ran no test, check, lint or build command';
  if (!last.passed) return 'the report says checks pass, but the agent\'s last ' + last.kind + ' command exited with code ' + (last.exitCode === null ? 'unknown' : last.exitCode);
  const issues = Array.isArray(outcome.verificationIssues) ? outcome.verificationIssues : Array.isArray(verification.issues) ? verification.issues : [];
  if (issues.some((issue) => STALE_CHECK.test(issue))) return 'the report says checks pass, but the agent edited files after its last passing check';
  return '';
}
