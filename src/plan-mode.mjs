// Plan mode: the current permission mode and the exit_plan_mode hand-off.

// Plan mode hand-off, like Claude Code's ExitPlanMode: show the plan, and on approval
// leave plan mode so the same turn can start implementing.
export async function exitPlanMode(session, args, context, options) {
  const plan = String(args.plan || '').trim().slice(0, 20000);
  if (!plan) return { approved: false, error: 'Provide the plan to present.' };
  if (options.planOnly) return { approved: false, message: 'This is a plan-only run. Give the plan as your final answer; the user will start implementation separately.' };
  if (!session.permissions || session.permissions.mode !== 'plan') return { approved: true, message: 'Plan mode is not active; continue with the task.' };
  const approval = context && context.approval;
  let answer = false;
  if (typeof approval === 'function') {
    answer = await approval('Oasis has a plan and wants to start implementing it:\n\n' + plan + '\n\nLeave plan mode and implement this plan?', true, { tool: 'exit_plan_mode' });
  }
  if (answer === true || answer === 'always') {
    const next = session.prePlanMode && session.prePlanMode !== 'plan' ? session.prePlanMode : 'default';
    session.permissions.setMode(next);
    return { approved: true, mode: next, message: 'The user approved the plan and plan mode is off (mode: ' + next + '). Implement it now: track the steps with todo_write, make the changes, and verify them.' };
  }
  return { approved: false, message: 'The user did not approve the plan yet. Stay in plan mode: ask what they would like changed, or refine the plan.' };
}

export function permissionMode(session, options) {
  if (options.planOnly) return 'plan';
  return (session.permissions && session.permissions.mode) || 'default';
}
