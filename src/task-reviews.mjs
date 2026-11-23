// Independent reviews of the current task (src/task-model.mjs).
//
// An agent does not certify its own work by finishing it. A task counts as
// independently verified only when a separate session (a code-review,
// security-review or verify subagent, or a run_specialist_review) inspected
// the result and passed it. Each review is recorded against the task it
// reviewed and the evidence epoch it saw: an edit after the review makes it a
// review of code that no longer exists, so it stops counting.
//
// A review's verdict is read from its report, not trusted blindly:
//
//   pass          the reviewer said so (VERDICT: PASS, or "no actionable
//                 defects") and actually inspected something, finished and
//                 named no severe finding
//   fail          the reviewer reported a confirmed defect (VERDICT: FAIL, or
//                 a critical/high finding)
//   inconclusive  anything else: the reviewer read nothing, ran out of
//                 budget, or the report says both
//
// Only pass raises the outcome; fail rejects it; inconclusive leaves the
// independent-review criterion unknown.

import { sessionEvidence } from './evidence-ledger.mjs';

/** Agent types whose report is an independent review of the work. */
export const REVIEWER_TYPES = Object.freeze(['code-review', 'security-review', 'verify']);
export const MAX_TASK_REVIEWS = 10;
export const MAX_TASK_WORKERS = 20;

const VERDICT_LINE = /^[\s*_#>-]*verdict\s*[:=-]\s*\**\s*(pass(?:ed)?|fail(?:ed)?|inconclusive)\b/gim;
const CLEAN = /\b(?:no (?:actionable|concrete|confirmed|real) (?:defects?|issues?|findings?|bugs?|vulnerabilit(?:y|ies)|problems?)|(?:found|find|identified) no (?:actionable |concrete |confirmed )?(?:defects?|issues?|bugs?|vulnerabilit(?:y|ies)|problems?)|no issues found|looks correct)\b/i;
const SEVERE = /(?:^|\n)\s*(?:[-*\d.)\s]*)(?:\*\*|\[|\()?\s*(?:critical|high|severity:\s*(?:critical|high))\b|\bconfirmed (?:defect|bug|vulnerability)\b/i;

/**
 * The verdict of one review report. `meta`: { finished, toolCalls,
 * limitReached }. Returns { verdict, reason }.
 */
export function reviewVerdict(text, { finished = true, toolCalls = null, limitReached = false } = {}) {
  const report = String(text || '');
  if (!report.trim()) return { verdict: 'inconclusive', reason: 'the reviewer returned no report' };
  const declared = [...report.matchAll(VERDICT_LINE)].map((match) => match[1].toLowerCase().startsWith('pass') ? 'pass' : match[1].toLowerCase().startsWith('fail') ? 'fail' : 'inconclusive').pop() || '';
  const severe = SEVERE.test(report);
  const clean = CLEAN.test(report);
  if (declared === 'fail' || (!declared && severe && !clean)) return { verdict: 'fail', reason: declared ? 'the reviewer reported VERDICT: FAIL' : 'the reviewer reported a severe finding' };
  const said = declared === 'pass' || (!declared && clean && !severe);
  if (!said) return { verdict: 'inconclusive', reason: declared === 'inconclusive' ? 'the reviewer could not decide' : 'the report states no verdict' };
  if (severe) return { verdict: 'inconclusive', reason: 'the reviewer passed it but also reported a severe finding' };
  if (limitReached || finished === false) return { verdict: 'inconclusive', reason: 'the review stopped at a limit before finishing' };
  if (toolCalls !== null && Number(toolCalls) <= 0) return { verdict: 'inconclusive', reason: 'the reviewer passed it without inspecting anything' };
  return { verdict: 'pass', reason: 'the reviewer inspected it and found no actionable defect' };
}

function firstLine(text, max = 200) {
  const line = String(text || '').split('\n').map((part) => part.trim()).find((part) => part && !/^verdict\b/i.test(part)) || '';
  return line.length > max ? line.slice(0, max - 1) + '…' : line;
}

/**
 * Records a review against the session's current task. `review`: { by,
 * text, finished, toolCalls, limitReached, epoch }. Returns the stored entry, or
 * null when there is no task to review.
 */
export function recordTaskReview(session, review = {}) {
  if (!session || typeof session !== 'object') return null;
  const ledger = sessionEvidence(session);
  const { verdict, reason } = reviewVerdict(review.text, review);
  const entry = {
    by: String(review.by || 'reviewer').slice(0, 80),
    verdict,
    detail: (reason + (firstLine(review.text) ? ': ' + firstLine(review.text) : '')).slice(0, 300),
    taskId: session.task && session.task.id || '',
    // The files the reviewer saw: the epoch when it started, if given.
    epoch: Number.isInteger(review.epoch) ? review.epoch : ledger ? ledger.epoch : 0,
    seq: ledger ? ledger.seq : 0,
    at: Date.now()
  };
  // The agents whose finished work this review saw: workers on this task
  // that changed files before the review started, not yet judged by an
  // earlier review of the same files.
  const workers = Array.isArray(session.taskWorkers) ? session.taskWorkers : [];
  entry.reviewed = workers.filter((worker) => worker.taskId === entry.taskId && worker.epoch <= entry.epoch && !worker.judged).map((worker) => worker.agentId);
  if (verdict !== 'inconclusive') for (const worker of workers) if (entry.reviewed.includes(worker.agentId)) worker.judged = verdict;
  if (!Array.isArray(session.taskReviews)) session.taskReviews = [];
  session.taskReviews.push(entry);
  if (session.taskReviews.length > MAX_TASK_REVIEWS) session.taskReviews.splice(0, session.taskReviews.length - MAX_TASK_REVIEWS);
  return entry;
}

/**
 * Reviews that still apply: of the current task, and of the files as they
 * are now (no edit since the review). Stale reviews are returned separately.
 */
export function currentReviews(session) {
  const reviews = session && Array.isArray(session.taskReviews) ? session.taskReviews : [];
  const ledger = sessionEvidence(session);
  const epoch = ledger ? ledger.epoch : 0;
  const taskId = session && session.task && session.task.id || '';
  const current = [];
  const stale = [];
  for (const review of reviews) {
    if (!review || (taskId && review.taskId && review.taskId !== taskId)) continue;
    (review.epoch === epoch ? current : stale).push(review);
  }
  return { current, stale };
}

/**
 * One summary of several current reviews: any fail fails; otherwise any
 * pass passes; otherwise inconclusive. null when there are none.
 */
export function combinedReview(reviews = []) {
  const list = reviews.filter(Boolean);
  if (!list.length) return null;
  const failed = list.filter((review) => review.verdict === 'fail');
  if (failed.length) return { ...failed[failed.length - 1], count: list.length };
  const passed = list.filter((review) => review.verdict === 'pass');
  if (passed.length) return { ...passed[passed.length - 1], by: [...new Set(passed.map((review) => review.by))].join(', '), count: list.length };
  return { ...list[list.length - 1], count: list.length };
}

/**
 * A delegated agent changed the parent's files (it ran in the same tree, not
 * an isolated worktree). The files a review saw before this are gone, so the
 * parent's evidence epoch moves on, and the agent is remembered as a worker
 * whose result a later review judges.
 */
export function noteTaskWorker(session, { agentId, agentType = '', startedAt = 0 } = {}) {
  if (!session || typeof session !== 'object' || !agentId) return null;
  const ledger = sessionEvidence(session);
  if (ledger) ledger.epoch += 1;
  const worker = { agentId: String(agentId), agentType: String(agentType || ''), taskId: session.task && session.task.id || '', epoch: ledger ? ledger.epoch : 0, startedAt: Number(startedAt) || 0, at: Date.now() };
  if (!Array.isArray(session.taskWorkers)) session.taskWorkers = [];
  session.taskWorkers = session.taskWorkers.filter((item) => item.agentId !== worker.agentId);
  session.taskWorkers.push(worker);
  if (session.taskWorkers.length > MAX_TASK_WORKERS) session.taskWorkers.splice(0, session.taskWorkers.length - MAX_TASK_WORKERS);
  return worker;
}
