// Spawn-time scope check (roadmap 2.2).
//
// A child never gets more reach than the agent that starts it. Its tools are
// already a subset of the parent's (agent-subagents.mjs filters the parent's
// list), so what is left to check is the parent's mode and the task itself:
//
// - A read-only parent (plan mode, or a subagent that is read-only) starts
//   only read-only children: the child runs in plan mode whatever its own
//   definition or tool list says.
// - A read-only parent cannot hand a child a task that is a deploy, publish,
//   push or release step. The child could not do it anyway, so this refuses
//   early with a reason instead of letting the child fail at approval time.
//
// The check runs for `task`, team members and workflow `agent()` alike,
// because all three start through runSubagent.

// Concrete deploy commands anywhere, or an instruction that starts with the
// verb ("Deploy the app", "Then publish it"). "Find out how deploys work" is
// research, not a deploy step, and is allowed.
const DEPLOY_COMMAND = /\b(?:npm\s+publish|pnpm\s+publish|yarn\s+(?:npm\s+)?publish|cargo\s+publish|twine\s+upload|gem\s+push|git\s+push|kubectl\s+(?:apply|rollout|delete)|terraform\s+(?:apply|destroy)|helm\s+(?:install|upgrade)|fly\s+deploy|vercel\s+(?:--prod|deploy)|netlify\s+deploy|firebase\s+deploy|docker\s+push|gh\s+release\s+create)\b/i;
const DEPLOY_INSTRUCTION = /(?:^|[.;:!?]\s+|\n)\s*(?:[-*]\s+|\d+[.)]\s+)?(?:please\s+|then\s+|now\s+|and\s+)?(?:deploy|publish|release|ship|push)\s+(?:it|this|that|them|the|a|an|to|v?\d|our|my|everything)\b/i;

export function isDeployStep(text) {
  const value = String(text || '');
  return DEPLOY_COMMAND.test(value) || DEPLOY_INSTRUCTION.test(value);
}

/** True when the parent may only read: plan mode, or a read-only subagent. */
export function parentIsReadOnly(parent, options = {}) {
  return Boolean(options.planOnly || (parent && (parent.scopeReadOnly === true || parent.permissionMode === 'plan')));
}

/**
 * Returns { readOnly, error } for a child about to start. `childReadOnly` is
 * what the child's own definition and tools work out to.
 */
export function spawnScope({ parent, options = {}, prompt = '', childReadOnly = false } = {}) {
  const parentReadOnly = parentIsReadOnly(parent, options);
  if (parentReadOnly && isDeployStep(prompt)) {
    return { readOnly: true, error: 'A read-only agent cannot start a subagent for a deploy, publish, push or release step. Plan the step and leave it to the user, or leave plan mode first.' };
  }
  return { readOnly: Boolean(childReadOnly || parentReadOnly), error: '' };
}
