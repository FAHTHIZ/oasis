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
    else if (event.kind === 'edit' && check) stale = true;
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
  const wanted = commands.length ? commands : [''];
  for (const command of wanted) {
    const check = latestCheck(events, command);
    const name = command ? '`' + command + '`' : 'a test or build check';
    if (!check) return { met: false, evidence: true, reason: 'OASIS has not seen ' + name + ' run in this session yet, so the condition is not verified. Run it.' };
    if (check.masked || check.passed === null) return { met: false, evidence: true, reason: 'The latest run of ' + describe(check) + ' did not report a usable exit status' + (check.masked ? ' (a pipe hid it)' : ' (it did not finish)') + '. Run it again so its own exit code shows.' };
    if (!check.passed) return { met: false, evidence: true, reason: 'The latest run of ' + describe(check) + ' exited ' + check.exitCode + '. Fix the failures and run it again.' };
    if (check.stale) return { met: false, evidence: true, reason: 'Files were edited after the last passing run of ' + describe(check) + '. Run it again to verify the current state.' };
  }
  return null;
}

/** What OASIS observed, for the judge: latest checks and commands, edits since. */
export function goalEvidenceText(events = []) {
  const lines = [];
  const recent = (events || []).filter((event) => event.kind === 'check' || event.kind === 'command' || event.kind === 'execution').slice(-MAX_LISTED);
  for (const event of recent) {
    const later = (events || []).some((other) => other.kind === 'edit' && other.seq > event.seq);
    const status = event.exitCode === null || event.exitCode === undefined ? 'did not finish' : 'exit ' + event.exitCode + (event.masked ? ' (hidden by a pipe)' : '');
    lines.push('- ' + (event.kind === 'check' ? 'check ' : 'ran ') + describe(event) + ': ' + status + (later ? ', files edited after it' : ''));
  }
  const edits = (events || []).filter((event) => event.kind === 'edit');
  const fetched = (events || []).filter((event) => event.kind === 'fetch').length;
  if (edits.length) lines.push('- ' + edits.length + ' file edit' + (edits.length === 1 ? '' : 's') + ' in total, last: ' + String(edits.at(-1).path || '').slice(-120));
  if (fetched) lines.push('- ' + fetched + ' page' + (fetched === 1 ? '' : 's') + ' fetched');
  if (!lines.length) return 'OASIS recorded no commands, checks, edits or fetched pages in this session.';
  return 'What OASIS recorded from tool results (not from the transcript):\n' + lines.join('\n');
}
