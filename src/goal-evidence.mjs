// Goal checks grounded in what actually ran.
//
// /goal and --goal keep OASIS working until a judge says the condition holds.
// That judge reads the transcript, and a transcript is the agent's own account
// of its work: "all tests pass" in a reply reads the same whether or not a
// test ran. Separate evaluators help, but out of the box they still talk
// themselves into approving work (Anthropic, "Harness design for long-running
// apps"). So before any model is asked, OASIS checks the condition against the
// evidence ledger (src/evidence-ledger.mjs), which only tool results write:
//
//   - A condition about checks passing ("npm test passes", "the build
//     succeeds") is NOT met while no such check has run, the latest one failed
//     or had its exit status hidden by a pipe, or files changed after it. No
//     model request is made for that verdict.
//   - Otherwise the judge gets a short list of what OASIS observed (latest
//     checks and commands with exit codes, edits since) and is told to trust
//     it over the transcript.

import { claimsPassing } from './claim-check.mjs';
import { changesFiles } from './evidence-ledger.mjs';

const COMMAND = /`([^`\n]{2,200})`|\b((?:npm|pnpm|yarn|bun)\s+(?:run\s+)?[\w:.-]+|npx\s+[\w@/.-]+(?:\s+[\w:.-]+)?|pytest(?:\s+[\w/.:-]+)?|python3?\s+-m\s+(?:pytest|unittest)|cargo\s+(?:test|build|check|clippy)|go\s+(?:test|build|vet)|make(?:\s+[\w.-]+)?|mvn\s+[\w:.-]+|gradle\w*\s+[\w:.-]+|dotnet\s+(?:test|build)|tsc|eslint|ruff(?:\s+check)?|mypy|phpunit|rspec|deno\s+(?:test|lint|check))\b/gi;
const MAX_LISTED = 8;

function words(text) {
  // "npm run test" and "npm test" are the same check.
  return String(text || '').toLowerCase().replace(/\s+/g, ' ').trim().replace(/\b(npm|pnpm|yarn|bun) run (test|start)\b/g, '$1 $2');
}

/** Commands a condition names, such as "npm test" in "npm test passes". */
export function conditionCommands(condition) {
  const found = [];
  for (const match of String(condition || '').matchAll(COMMAND)) {
    const command = words(match[1] || match[2]);
    if (command && !found.includes(command)) found.push(command);
  }
  return found.slice(0, 5);
}

/** The latest check matching `command` (or any check), with `stale` when an edit came after it. */
function latestCheck(events, command = '') {
  let check = null;
  let stale = false;
  for (const event of events || []) {
    if (event.kind === 'check' && (!command || words(event.command).includes(command))) { check = event; stale = false; }
    else if (changesFiles(event) && check) stale = event.kind === 'edit' ? 'edit' : (stale || event.command || 'a command');
  }
  return check ? { ...check, stale } : null;
}

function describe(check) {
  return '`' + String(check.command || 'a check').slice(0, 120) + '`';
}

/**
 * The verdict the evidence alone gives, or null when it takes judgement.
 * Returns { met: false, reason, evidence: true } when a check the condition
 * depends on has not passed since the last edit.
 */
export function goalEvidenceGate(condition, events = []) {
  const commands = conditionCommands(condition);
  const aboutChecks = claimsPassing(condition) || (commands.length > 0 && /\b(?:pass(?:es|ing)?|green|succeed(?:s|ing)?|clean|exit(?:s)?\s+(?:with\s+)?0|without (?:errors?|failures?))\b/i.test(String(condition)));
  if (!aboutChecks) return null;
  const tamper = [...(events || [])].reverse().find((event) => event && event.kind === 'tamper');
  if (tamper && Array.isArray(tamper.files) && tamper.files.length) return { met: false, evidence: true, reason: 'Tests were weakened instead of the code being fixed (' + tamper.files.join('; ') + '). Restore them and fix the code.' };
  const wanted = commands.length ? commands : [''];
  for (const command of wanted) {
    const check = latestCheck(events, command);
    const name = command ? '`' + command + '`' : 'a test or build check';
    if (!check) return { met: false, evidence: true, reason: 'OASIS has not seen ' + name + ' run in this session yet, so the condition is not verified. Run it.' };
    if (check.masked || check.passed === null) return { met: false, evidence: true, reason: 'The latest run of ' + describe(check) + ' did not report a usable exit status' + (check.masked ? ' (a pipe hid it)' : ' (it did not finish)') + '. Run it again so its own exit code shows.' };
    if (!check.passed) return { met: false, evidence: true, reason: 'The latest run of ' + describe(check) + ' exited ' + check.exitCode + '. Fix the failures and run it again.' };
    if (check.noTests) return { met: false, evidence: true, reason: 'The latest run of ' + describe(check) + ' exited 0 but ran no tests. Run the suite so tests actually execute.' };
    if (check.filtered && !/\b(?:only|grep|filter|matching|named)\b/i.test(String(condition))) return { met: false, evidence: true, reason: 'The latest run of ' + describe(check) + ' selected only some tests. Run it without a filter to verify the whole condition.' };
    if (check.stale) return { met: false, evidence: true, reason: (check.stale === 'edit' ? 'Files were edited after the last passing run of ' + describe(check) : '`' + String(check.stale).slice(0, 120) + '` can change files and ran after the last passing run of ' + describe(check)) + '. Run it again to verify the current state.' };
  }
  // The whole condition is one check passing ("npm test passes") and the
  // record shows exactly that: no judge request. On a local model that request
  // re-reads the whole transcript, which takes minutes on a CPU.
  if (commands.length === 1 && PURE_CHECK.test(String(condition).replace(/`/g, '').trim()) && words(String(condition).replace(/`/g, '')).startsWith(commands[0])) {
    const check = latestCheck(events, commands[0]);
    return { met: true, evidence: true, reason: 'OASIS saw ' + describe(check) + ' exit 0 after the last edit.' };
  }
  return null;
}

const PURE_CHECK = /^[\w@/.:\s-]+?\s+(?:passes|pass|succeeds|is green|exits (?:with )?0|runs without (?:errors?|failures?))\.?$/i;

/** What OASIS observed, for the judge: latest checks and commands, edits since. */
export function goalEvidenceText(events = []) {
  const lines = [];
  const recent = (events || []).filter((event) => event.kind === 'check' || event.kind === 'command' || event.kind === 'execution').slice(-MAX_LISTED);
  for (const event of recent) {
    const later = (events || []).some((other) => other.kind === 'edit' && other.seq > event.seq);
    const status = event.exitCode === null || event.exitCode === undefined ? 'did not finish' : 'exit ' + event.exitCode + (event.masked ? ' (hidden by a pipe)' : '');
    lines.push('- ' + (event.kind === 'check' ? 'check ' : 'ran ') + describe(event) + ': ' + status + (event.noTests ? ', but no tests ran' : '') + (event.filtered ? ', a filtered run' : '') + (later ? ', files edited after it' : ''));
  }
  const edits = (events || []).filter((event) => event.kind === 'edit');
  const fetched = (events || []).filter((event) => event.kind === 'fetch').length;
  if (edits.length) lines.push('- ' + edits.length + ' file edit' + (edits.length === 1 ? '' : 's') + ' in total, last: ' + String(edits.at(-1).path || '').slice(-120));
  if (fetched) lines.push('- ' + fetched + ' page' + (fetched === 1 ? '' : 's') + ' fetched');
  if (!lines.length) return 'OASIS recorded no commands, checks, edits or fetched pages in this session.';
  return 'What OASIS recorded from tool results (not from the transcript):\n' + lines.join('\n');
}

/**
 * Whether a goal is confirmed by the separate `verify` agent before it counts
 * as met: `goalVerifier: "agent"` in settings, OASIS_GOAL_VERIFIER=agent, or
 * `--goal-verify`. Off by default, since it runs a whole agent per check.
 */
export function goalVerifierEnabled(session, env = process.env, option) {
  if (option === true || option === 'agent') return true;
  if (option === false || option === 'judge') return false;
  const value = String(env.OASIS_GOAL_VERIFIER || (session && session.settings && session.settings.goalVerifier) || '').trim().toLowerCase();
  return value === 'agent';
}

export function goalVerifierPrompt(condition, judgeReason = '') {
  return 'Acceptance criteria (the goal another agent is working toward):\n' + String(condition).slice(0, 8000) +
    (judgeReason ? '\n\nThat agent\'s reviewer believes it is met: ' + String(judgeReason).slice(0, 600) : '') +
    '\n\nFind out whether the goal really holds in the workspace now. Split it into concrete criteria, exercise each one yourself, and end with the PASS/FAIL lines and the VERDICT line.';
}

/** { met, reason } from the verify agent's task result. */
export function parseVerifierResult(result) {
  const report = String(result && result.report || '');
  const verdicts = [...report.matchAll(/VERDICT:\s*(PASS|FAIL)\b[^\n]*/gi)];
  const last = verdicts.at(-1);
  const failures = report.split('\n').map((line) => line.trim()).filter((line) => /^(?:[-*]\s*)?FAIL\b/i.test(line));
  if (!last) return { met: false, reason: 'The verify agent gave no verdict' + (failures.length ? '; it reported: ' + failures[0].slice(0, 300) : '.'), verifier: true };
  if (last[1].toUpperCase() !== 'PASS') return { met: false, reason: 'The verify agent found: ' + (failures[0] || last[0]).replace(/^(?:[-*]\s*)?FAIL:?\s*/i, '').slice(0, 400), verifier: true };
  if (failures.length) return { met: false, reason: 'The verify agent said PASS but listed a failed criterion: ' + failures[0].slice(0, 300), verifier: true };
  // A verifier that read something shaped like a prompt injection may have
  // been talked into its PASS; it does not count as confirmation.
  if (result.untrusted_input) return { met: false, reason: 'The verify agent said PASS, but it read content that looked like a prompt-injection attempt, so its verdict does not count. ' + String(result.untrusted_input).slice(0, 200), verifier: true };
  if (result.unverified_claim || result.report_status === 'rejected') return { met: false, reason: 'The verify agent said PASS, but OASIS saw no passing check behind it (' + String(result.unverified_claim || 'report rejected').slice(0, 200) + ').', verifier: true };
  return { met: true, reason: 'Confirmed by the verify agent. ' + last[0].slice(0, 300), verifier: true };
}

/**
 * Independent review of a finished task (`--review`): the request becomes the
 * acceptance criteria for the `verify` agent. A separate critic after the work
 * is the best accuracy-for-cost verification design measured so far: +5.9 to
 * +9.5 points on Terminal-Bench at 1.13-1.25x cost, ahead of completion gates
 * (Zhang et al., "Rethinking Verification in Agent Harnesses", arXiv:2610.34577).
 */
export function reviewPrompt(request, summary = '') {
  return 'Acceptance criteria (the task another agent was given):\n' + String(request).slice(0, 8000) +
    (summary ? '\n\nThat agent says it is done: ' + String(summary).slice(0, 1200) : '') +
    '\n\nFind out whether the task is really done in the workspace now: what was asked is implemented, it works when exercised, and nothing that worked before is broken. Split it into concrete criteria, check each one yourself, and end with the PASS/FAIL lines and the VERDICT line.';
}

/** Review rounds from --review N, OASIS_REVIEW or settings.review (0 = off, at most 3). */
export function reviewRounds(session, env = process.env, option) {
  const raw = option !== undefined && option !== null ? option : env.OASIS_REVIEW !== undefined && env.OASIS_REVIEW !== '' ? env.OASIS_REVIEW : session && session.settings && session.settings.review;
  if (raw === true) return 1;
  const value = Number.parseInt(String(raw ?? 0), 10);
  return Number.isInteger(value) && value > 0 ? Math.min(3, value) : 0;
}
