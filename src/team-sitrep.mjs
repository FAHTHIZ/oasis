// Coordinator sitrep: what needs the main agent's attention, ranked.
//
// A coordinator with five workers has state spread over four places: the
// agent registry (who is running, who failed), the dialogue ledger (who owes
// whom a reply), the knowledge board (findings that contradict each other)
// and the hypotheses matrix (questions not yet settled). Reading them one by
// one is how a coordinator misses the failed worker or the request addressed
// to it. team_status (without team_id) folds them into one ranked list:
//
//   1  act now     a request or challenge addressed to you, a failed worker,
//                  "none of these" leading a question
//   2  unblock     a dispute between findings, a thread stalled for minutes
//                  while its owner keeps running, a question whose leader
//                  rests on one agent's evidence
//   3  next        close leaders with an informative test to run, untested
//                  hypotheses
//
// Each item says what is wrong and the concrete next action. Pure: callers
// pass the registry, board and clock.

import { openThreads } from './agent-dialogue.mjs';
import { openConflicts } from './knowledge-board.mjs';
import { questionView } from './hypothesis-board.mjs';

const STALL_SECONDS = 300;
const MAX_ITEMS = 12;

function clip(text, n = 120) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > n ? value.slice(0, n - 1) + '…' : value;
}

/** Ranked attention items for the coordinator. */
export function buildSitrep({ registry, board, self = 'main', now = Date.now() } = {}) {
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

  for (const conflict of board ? openConflicts(board) : []) {
    const [a, b] = conflict.findings;
    items.push({ priority: 2, kind: 'dispute', ref: a + '|' + b, what: a + ' (' + conflict.authors[0] + ': "' + clip(conflict.claims[0], 90) + '") contradicts ' + b + ' (' + conflict.authors[1] + ': "' + clip(conflict.claims[1], 90) + '")' + (conflict.reason ? ' [' + clip(conflict.reason, 60) + ']' : ''), do: 'Check both against their sources and retract the wrong one, or open it on the hypotheses matrix if more evidence is needed. Do not report either as fact until settled.' });
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
      items.push({ priority: 3, kind: 'close_call', ref: question.id, what: label + ': ' + first.id + ' (' + first.posterior + ') vs ' + second.id + ' (' + second.posterior + ').', do: 'Find evidence they predict differently ("' + clip(first.text, 50) + '" vs "' + clip(second.text, 50) + '").' });
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
