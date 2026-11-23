// Coordinator sitrep: what needs the main agent's attention, ranked.
//
// A coordinator with five workers has state spread over five places: the
// agent registry (who is running, who failed), the dialogue ledger (who owes
// whom a reply), the shared task board (promised work left unowned), the
// knowledge board (findings that contradict each other) and the hypotheses
// matrix (questions not yet settled). Reading them one by one is how a
// coordinator misses the failed worker or the request addressed to it. team_status (without team_id) folds them into one ranked list:
//
//   1  act now     a request or challenge addressed to you, a failed worker,
//                  "none of these" leading a question
//   2  unblock     a dispute between findings, a finding whose premise was
//                  retracted (undermined), a thread stalled for minutes
//                  while its owner keeps running, a promise whose author
//                  finished without delivering it (now an unowned task), a question whose leader
//                  rests on one agent's evidence
//   3  next        close leaders with an informative test to run, untested
//                  hypotheses
//
// Each item says what is wrong and the concrete next action. Pure: callers
// pass the registry, board and clock.

import { openThreads } from './agent-dialogue.mjs';
import { openConflicts, underminedFindings } from './knowledge-board.mjs';
import { questionView } from './hypothesis-board.mjs';

const STALL_SECONDS = 300;
const MAX_ITEMS = 12;

function clip(text, n = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > n ? value.slice(0, n - 1) + '…' : value;
}

/** Ranked attention items for the coordinator. */
export function buildSitrep({ registry, board, tasks = null, self = 'main', now = Date.now() } = {}) {
  const items = [];
  const agents = registry && registry.agents instanceof Map ? [...registry.agents.values()] : [];
  const running = agents.filter((agent) => agent.status === 'running');
  const byId = new Map(agents.map((agent) => [agent.id, agent]));

  for (const agent of agents) {
    if (agent.status !== 'failed' && agent.status !== 'stalled') continue;
    items.push({ priority: 1, kind: 'failed_agent', ref: agent.id, what: agent.id + ' (' + clip(agent.description || agent.type, 60) + ') ' + agent.status + ': ' + clip(agent.error || 'no error recorded', 140), do: 'Read agent_status ' + agent.id + ', then retry with a narrower prompt, reassign, or do it yourself.' });
  }

  const threads = registry ? openThreads(registry) : [];
  for (const thread of threads) {
    if (thread.owed_by === self) {
      items.push({ priority: 1, kind: 'owed_by_you', ref: thread.id, what: thread.from + ' sent you a ' + thread.act + ' (' + thread.id + '): "' + clip(thread.text) + '"', do: thread.act === 'commit' ? 'Deliver it, then team_send_message reply_to ' + thread.id + '.' : 'team_send_message to "' + thread.from + '" with act answer/accept/reject and reply_to "' + thread.id + '".' });
      continue;
    }
    const owner = byId.get(thread.owed_by);
    if (thread.age_s >= STALL_SECONDS && owner && owner.status === 'running') {
      items.push({ priority: 2, kind: 'stalled_thread', ref: thread.id, what: thread.owed_by + ' has owed ' + thread.from + ' a reply to ' + thread.id + ' for ' + Math.round(thread.age_s / 60) + ' min: "' + clip(thread.text, 100) + '"', do: 'Nudge ' + thread.owed_by + ' with team_send_message, or answer it yourself if you know.' });
    }
  }

  for (const task of tasks && Array.isArray(tasks.tasks) ? tasks.tasks : []) {
    if (!task.promise || !task.promise.lapsed || task.status !== 'pending' || task.claimedBy) continue;
    items.push({ priority: 2, kind: 'orphaned_promise', ref: task.id, what: task.createdBy + ' promised ' + task.promise.to + ' "' + clip(task.description.split('\n[OASIS]')[0], 100) + '" (' + task.promise.message + ') and finished without delivering; ' + task.id + ' is unowned.', do: 'Assign ' + task.id + ' (dispatch_ready_tasks or a task with this description), or tell ' + task.promise.to + ' it will not come.' });
  }

  for (const conflict of board ? openConflicts(board) : []) {
    const [a, b] = conflict.findings;
    items.push({ priority: 2, kind: 'dispute', ref: a + '|' + b, authors: conflict.authors, what: a + ' (' + conflict.authors[0] + ': "' + clip(conflict.claims[0], 90) + '") contradicts ' + b + ' (' + conflict.authors[1] + ': "' + clip(conflict.claims[1], 90) + '")' + (conflict.reason ? ' [' + clip(conflict.reason, 60) + ']' : ''), do: 'Check both against their sources and retract the wrong one, or open it on the hypotheses matrix if more evidence is needed. Do not report either as fact until settled.' });
  }

  for (const { entry, fallen } of board ? underminedFindings(board) : []) {
    items.push({ priority: 2, kind: 'undermined', ref: entry.id, what: entry.id + ' (' + entry.author + ': "' + clip(entry.claim, 90) + '") builds on ' + fallen.map((item) => item.id).join(', ') + ', since retracted.', do: 'Have ' + entry.author + ' (or someone) re-check ' + entry.id + ' and retract it or re-post it on its own evidence; do not report it as fact meanwhile.' });
  }

  const questions = board && board.hypotheses && Array.isArray(board.hypotheses.questions) ? board.hypotheses.questions : [];
  for (const question of questions) {
    if (question.resolved) continue;
    const view = questionView(question);
    const [first, second] = view.hypotheses;
    const label = question.id + ' "' + clip(question.text, 80) + '"';
    if (first && view.none_of_these > Math.max(0.3, first.posterior)) {
      items.push({ priority: 1, kind: 'missing_hypothesis', ref: question.id, what: label + ': "none of these" leads (' + view.none_of_these + '); the evidence contradicts every listed hypothesis.', do: 'Add the explanation you are missing (hypotheses action add) or send an agent to look for it.' });
      continue;
    }
    if (view.state === 'leading') {
      items.push({ priority: 3, kind: 'ready_to_resolve', ref: question.id, what: label + ': ' + first.id + ' leads at ' + first.posterior + ' with independent support.', do: 'Resolve it (hypotheses action resolve) once you agree.' });
      continue;
    }
    if (first && first.posterior >= 0.85) {
      items.push({ priority: 2, kind: 'thin_lead', ref: question.id, what: label + ': ' + first.id + ' leads at ' + first.posterior + ' but not on two agents and two independent sources.', do: 'Have a different agent check ' + first.id + ' against an independent source.' });
    } else if (first && second && first.posterior - second.posterior < 0.3) {
      items.push({ priority: 3, kind: 'close_call', ref: question.id, what: label + ': ' + first.id + ' (' + first.posterior + ') vs ' + second.id + ' (' + second.posterior + ').', do: 'Find evidence they predict differently ("' + clip(first.text, 50) + '" vs "' + clip(second.text, 50) + '"); rank candidate tests with hypotheses action plan before running them.' });
    }
    const untested = view.hypotheses.filter((h) => !h.tested);
    if (untested.length && view.evidence.length) items.push({ priority: 3, kind: 'untested', ref: question.id, what: label + ': no evidence yet on ' + untested.map((h) => h.id).join(', ') + '.', do: 'Look for evidence that would rule them out.' });
  }

  items.sort((a, b) => a.priority - b.priority);
  const counts = {
    running: running.length,
    finished: agents.filter((agent) => agent.status === 'completed').length,
    failed: items.filter((item) => item.kind === 'failed_agent').length,
    open_threads: threads.length,
    disputes: items.filter((item) => item.kind === 'dispute').length,
    open_questions: questions.filter((q) => !q.resolved).length
  };
  const summary = counts.running + ' running, ' + counts.finished + ' finished, ' + counts.failed + ' failed; ' + counts.open_threads + ' open thread' + (counts.open_threads === 1 ? '' : 's') + ', ' + counts.disputes + ' dispute' + (counts.disputes === 1 ? '' : 's') + ', ' + counts.open_questions + ' open question' + (counts.open_questions === 1 ? '' : 's') + '.';
  return { summary, counts, attention: items.slice(0, MAX_ITEMS), ...(items.length > MAX_ITEMS ? { more: items.length - MAX_ITEMS } : {}), ...(items.length ? {} : { note: 'Nothing needs your attention.' }) };
}

// Attention alerts. The coordinator should not have to poll team_status to
// learn that two workers now contradict each other or that a promise was
// orphaned. Before each model step of the main agent, items of these kinds
// that it has not been told about yet are delivered once as a short
// reminder. Failed workers are left out: their failure notice already
// arrives. OASIS_SITREP_ALERTS=0 turns this off.
const ALERT_KINDS = new Set(['dispute', 'undermined', 'orphaned_promise', 'missing_hypothesis', 'stalled_thread', 'owed_by_you']);
const MAX_ALERTED = 500;

export function sitrepAlertsEnabled(env = process.env) {
  return !/^(0|false|off|no)$/i.test(String(env.OASIS_SITREP_ALERTS || '').trim());
}

/** New attention items for the main agent since the last call, as a reminder; '' when none. */
export function sitrepAlerts(session, { env = process.env, now = Date.now() } = {}) {
  if (!session || !sitrepAlertsEnabled(env)) return '';
  const registry = session.agentTasks;
  const hasAgents = registry && registry.agents instanceof Map && registry.agents.size > 0;
  const board = session.knowledgeBoard;
  const hasQuestions = board && board.hypotheses && Array.isArray(board.hypotheses.questions) && board.hypotheses.questions.length > 0;
  if (!hasAgents && !hasQuestions) return '';
  const seen = session.sitrepAlerted instanceof Set ? session.sitrepAlerted : (session.sitrepAlerted = new Set());
  const self = session.agentId || 'main';
  let sitrep;
  try { sitrep = buildSitrep({ registry, board, tasks: session.sharedTasks, self, now }); } catch { return ''; }
  // A dispute the coordinator took part in was already reported to it by knowledge_post.
  const fresh = sitrep.attention.filter((item) => ALERT_KINDS.has(item.kind) && !seen.has(item.kind + ':' + item.ref) && !(item.kind === 'dispute' && item.authors.includes(self)));
  if (!fresh.length) return '';
  for (const item of fresh) seen.add(item.kind + ':' + item.ref);
  if (seen.size > MAX_ALERTED) for (const key of [...seen].slice(0, seen.size - MAX_ALERTED)) seen.delete(key);
  return '<system-reminder>OASIS sitrep: ' + fresh.length + ' new item' + (fresh.length === 1 ? '' : 's') + ' need' + (fresh.length === 1 ? 's' : '') + ' your attention.\n'
    + fresh.map((item) => '- ' + item.what + ' Next: ' + item.do).join('\n')
    + '\nteam_status shows the full ranked list.</system-reminder>';
}
