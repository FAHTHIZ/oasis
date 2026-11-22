// Automatic recovery of background agents.
//
// A background agent that stalls (the stall monitor in src/subagent-support.mjs
// stopped it) or fails on something that clears by itself (a dropped
// connection, a provider outage that outlasted the request retries) is
// restarted from its own conversation, with a note about what happened,
// instead of dying with half its work done while the parent is busy elsewhere.
//
// Only what is safe to repeat is recovered: never a cancelled agent, an agent
// whose worktree was already cleaned up, an agent working a shared-board task
// (its lease is released on failure and the board hands the task out again),
// or failures that would recur (budget exhausted, hard quota, invalid config,
// a refused permission). The default is one restart per agent; set
// `subagentAutoRecover` (0-3) or OASIS_SUBAGENT_AUTO_RECOVER, 0 turns it off.

import { RETRYABLE_PROVIDER_STATUSES, isHardQuotaError } from './provider-retry.mjs';

export const DEFAULT_AUTO_RECOVERIES = 1;
const MAX_AUTO_RECOVERIES = 3;
// Before restarting after a failure, give a flaky provider or network a moment.
const FAILURE_DELAY_MS = 20000;

const TRANSIENT_CODES = new Set(['OASIS_STREAM_INTERRUPTED', 'OASIS_NETWORK', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT']);
const TRANSIENT_TEXT = /fetch failed|socket hang up|network (?:error|is unreachable)|connection (?:reset|refused|closed|terminated)|timed? ?out|temporarily unavailable|overloaded|service unavailable|bad gateway|gateway timeout|stream (?:stalled|interrupted)|rate limit|too many requests/i;
// Failures that a restart would only repeat.
const PERMANENT_TEXT = /budget|max-budget|spend cap|not allowed|denied|permission|unauthori[sz]ed|forbidden|invalid api key|api key|unknown model|model .*not (?:found|available)|context (?:length|window)|too large|schema|cannot be resumed/i;

export function autoRecoveryLimit(session, env = process.env) {
  const raw = env && env.OASIS_SUBAGENT_AUTO_RECOVER !== undefined && env.OASIS_SUBAGENT_AUTO_RECOVER !== '' ? env.OASIS_SUBAGENT_AUTO_RECOVER : session && session.subagentAutoRecover;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_AUTO_RECOVERIES;
  if (raw === false || /^(?:false|off|no)$/i.test(String(raw))) return 0;
  if (raw === true || /^(?:true|on|yes)$/i.test(String(raw))) return DEFAULT_AUTO_RECOVERIES;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? Math.min(MAX_AUTO_RECOVERIES, value) : DEFAULT_AUTO_RECOVERIES;
}

/** Whether an error from a failed run is likely to clear on its own. */
export function isTransientFailure(error) {
  if (!error) return false;
  const text = String(error.message || error);
  if (isHardQuotaError(text) || PERMANENT_TEXT.test(text)) return false;
  const status = Number(error.status || (error.cause && error.cause.status));
  if (Number.isInteger(status) && status > 0) return RETRYABLE_PROVIDER_STATUSES.has(status) || status >= 500;
  const code = String(error.code || (error.cause && error.cause.code) || '');
  return TRANSIENT_CODES.has(code) || TRANSIENT_TEXT.test(text);
}

/**
 * The restart for a background agent whose run just ended in `error`, or null
 * when it should be reported as it is. Returns { delayMs, prompt, reason }.
 */
export function recoveryPlan(parent, record, error, env = process.env) {
  if (!parent || !record || parent.closed) return null;
  if (record.cancelRequested || record.status === 'cancelled' || (error && error.name === 'AbortError' && !record.stalled)) return null;
  if (!record.child || !record.resumable || record.sharedTaskId) return null;
  const limit = autoRecoveryLimit(parent, env);
  if ((record.autoRecoveries || 0) >= limit) return null;
  const stalled = record.status === 'stalled';
  if (!stalled && !(record.status === 'failed' && isTransientFailure(error))) return null;
  const what = stalled ? String(record.stalled || 'it stalled').replace(/;? ?the agent was stopped as stalled\.?$/i, '') : String(error && error.message || 'an error').slice(0, 300);
  return {
    delayMs: stalled ? 0 : FAILURE_DELAY_MS,
    reason: (stalled ? 'stalled: ' : 'failed: ') + what,
    prompt: 'OASIS stopped your previous run (' + (stalled ? 'no progress: ' + what : 'error: ' + what) + ') and restarted you automatically, with your conversation so far. '
      + 'Check the current state of the files before continuing, since your last step may not have finished. '
      + (stalled ? 'If a command hung, do not run it the same way again: add a timeout, run it in the background or take another route. ' : '')
      + 'Then finish the original task and report as before.'
  };
}

/** Waits `ms` unless the agent is cancelled or resumed by someone else first. */
export function waitForRecovery(record, ms) {
  if (!ms) return Promise.resolve(true);
  return new Promise((resolve) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (record.cancelRequested || record.status === 'running' || record.status === 'cancelled') { clearInterval(timer); resolve(false); }
      else if (Date.now() - started >= ms) { clearInterval(timer); resolve(true); }
    }, Math.min(500, ms));
  });
}
