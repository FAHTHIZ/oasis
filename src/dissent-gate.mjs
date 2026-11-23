// Dissent gate: a final answer may not quietly pick a side the team has not
// settled.
//
// The knowledge board records disputes between findings (src/claim-conflict.mjs)
// and the hypotheses matrix records questions the evidence has not decided
// (src/hypothesis-board.mjs). Both are lost if the agent's final answer states
// one side as fact: the user never learns there was disagreement. Before a
// turn ends, this gate reads the reply against what is still open:
//
//   - an open dispute where the reply repeats what is distinctive about one
//     side (its figure, version or wording) and nothing of the other, on the
//     same subject, without saying the point is disputed or uncertain
//   - an open question on the matrix whose top hypothesis the reply states
//     while the matrix has not reached "leading"
//
// It sends the reply back once with the specific disputes: report both sides,
// settle the dispute first (retract a finding, add evidence, resolve the
// question), or say how sure it is. Off with OASIS_DISSENT_GATE=0.

import { tokenize } from './auto-memory.mjs';
import { openConflicts } from './knowledge-board.mjs';
import { scoreQuestion } from './hypothesis-board.mjs';

const HEDGES = /\b(disput\w*|contest\w*|conflict\w*|disagree\w*|contradict\w*|uncertain\w*|unclear|unsettled|unresolved|not (?:yet )?(?:settled|confirmed|verified|certain|sure)|other sources?|another source|some sources|sources (?:differ|vary)|either|alternatively|competing|on the other hand|whereas|possibl\w*|probabl\w*|likely|might|may be|maybe|appears?|seems?|reportedly|according to)\b/i;
const MIN_SUBJECT = 2;

export function dissentGateEnabled(env = process.env) {
  return String(env.OASIS_DISSENT_GATE || '').trim() !== '0';
}

function tokens(text) {
  return new Set(tokenize(String(text || '')));
}

function sideOf(reply, left, right) {
  const a = tokens(left);
  const b = tokens(right);
  const shared = [...a].filter((term) => b.has(term));
  const onlyA = [...a].filter((term) => !b.has(term));
  const onlyB = [...b].filter((term) => !a.has(term));
  const subject = shared.filter((term) => reply.has(term)).length;
  if (subject < Math.min(MIN_SUBJECT, shared.length) || !shared.length) return null;
  const hitA = onlyA.filter((term) => reply.has(term));
  const hitB = onlyB.filter((term) => reply.has(term));
  // A side is taken when the reply carries its distinctive part and none of
  // the other's. Numbers and versions are distinctive on their own.
  const strong = (hits, all) => hits.length && (hits.some((term) => /\d/.test(term)) || hits.length >= Math.max(1, Math.ceil(all.length / 2)));
  if (strong(hitA, onlyA) && !hitB.length) return 'left';
  if (strong(hitB, onlyB) && !hitA.length) return 'right';
  return null;
}

/** Disputes and open questions the reply takes a side on without saying so. Pure. */
export function unacknowledgedDissent(board, text) {
  const reply = String(text || '');
  if (!board || !reply.trim() || HEDGES.test(reply)) return [];
  const words = tokens(reply);
  const found = [];
  for (const conflict of openConflicts(board)) {
    const [leftId, rightId] = conflict.findings;
    const left = board.entries.find((entry) => entry.id === leftId);
    const right = board.entries.find((entry) => entry.id === rightId);
    if (!left || !right) continue;
    const side = sideOf(words, left.claim, right.claim);
    if (!side) continue;
    const [taken, other] = side === 'left' ? [left, right] : [right, left];
    found.push({ kind: 'dispute', id: taken.id, against: other.id, taken: taken.claim.slice(0, 200), other: other.claim.slice(0, 200), other_author: other.author });
  }
  const questions = board.hypotheses && Array.isArray(board.hypotheses.questions) ? board.hypotheses.questions : [];
  for (const question of questions) {
    if (question.resolved || question.hypotheses.length < 2) continue;
    const score = scoreQuestion(question);
    const ranked = [...question.hypotheses].sort((a, b) => score.posterior.get(b.id) - score.posterior.get(a.id));
    const [top, next] = ranked;
    if (score.posterior.get(top.id) >= 0.85) continue;
    const side = sideOf(words, top.text + ' ' + question.text, next.text + ' ' + question.text);
    if (side !== 'left') continue;
    found.push({ kind: 'question', id: question.id, taken: top.text.slice(0, 200), posterior: Math.round(score.posterior.get(top.id) * 100) / 100, other: next.text.slice(0, 200) });
  }
  return found.slice(0, 4);
}

export function dissentNudge(items) {
  const lines = items.map((item) => item.kind === 'dispute'
    ? '- You state ' + item.id + ' ("' + item.taken + '"), but it is disputed by ' + item.against + ' from ' + item.other_author + ' ("' + item.other + '").'
    : '- You state "' + item.taken + '" for ' + item.id + ', but the hypotheses matrix gives it ' + item.posterior + ' and has not settled it (next: "' + item.other + '").');
  return '<system-reminder>Your answer takes one side of something this session has not settled:\n' + lines.join('\n')
    + '\nDo one of these before finishing: tell the user both sides and which you believe and why; settle it first (check the sources, then knowledge_post retract the wrong finding, or add evidence and resolve the question); or say plainly how sure you are. Do not hide the disagreement, and do not mention this note.</system-reminder>';
}
