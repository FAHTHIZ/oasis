// Evidence-based model escalation for cascade routing.
//
// In cascade mode (settings modelRouting.mode = "cascade") a coding task
// starts on the cheaper configured model. The turn loop already detects a run
// that is going nowhere: the same failure surviving several rounds of edits,
// the same failing command retried unchanged, identical tool calls repeating,
// or a no-progress cycle. Without a cascade those signals stop the turn with
// "I'm stuck". With one, the first signal hands the rest of the turn to the
// strong model instead, once, with a note saying what was tried.
//
// What this does not do: it does not judge answer quality, and it cannot see
// a cheap model that confidently finishes with a wrong answer the completion
// gates accept. It escalates on objective evidence of being stuck only.

import { routeCost, zeroBudgetEnabled } from './cost-policy.mjs';

/** Per-turn escalation state for a routed task, or null when there is nothing to escalate to. */
export function newEscalation(route = {}, { session = {}, env = process.env, allowed = () => true } = {}) {
  if (!route || route.tier !== 'work' || !route.escalateTo || route.escalateTo === route.model) return null;
  const state = { from: route.model, to: route.escalateTo, done: null, skipped: '' };
  if (!allowed(route.escalateTo)) state.skipped = route.escalateTo + ' is not in availableModels';
  else if (zeroBudgetEnabled(session, env)) {
    const verdict = routeCost({ ...(session.config || {}), model: route.escalateTo }, { session, env });
    if (verdict.cost !== 'free') state.skipped = 'zero-budget mode: ' + route.escalateTo + ' is ' + verdict.cost + ' (' + verdict.reason + ')';
  }
  return state;
}

export function canEscalate(state) {
  return Boolean(state && !state.done && !state.skipped);
}

/** Records the hand-over and returns the note for the new model, or '' when escalation is not possible. */
export function escalate(state, { evidence, step, signal }) {
  if (!canEscalate(state)) return '';
  const reason = String(evidence || '').replace(/^I[’']m stuck:\s*/, '').trim();
  state.done = { step, signal, from: state.from, to: state.to, reason: reason.slice(0, 500) };
  return '<system-reminder>Oasis handed this task from ' + state.from + ' to you (' + state.to + ') because the run was stuck: ' +
    reason + ' Everything above is the earlier model\'s work. Do not repeat what already failed. Re-read the exact error and the code it points to, ' +
    'find the cause, and finish the task the user asked for.</system-reminder>';
}

/** Evidence text for a failure that survived several rounds of edits. */
export function thrashEvidence(command, count) {
  return 'the same failure of `' + String(command || 'a check').slice(0, 160) + '` survived ' + count + ' rounds of edits.';
}
