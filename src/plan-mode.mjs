// Plan mode: the current permission mode and the exit_plan_mode hand-off.
import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { getConfigDirectory } from './config.mjs';

// Claude Code's plansDirectory: a folder relative to the project root for the plan files.
// A path that leaves the root or contains a backslash falls back to <OASIS config>/plans.
export function plansDirectoryFor(root, setting, env = process.env) {
  if (typeof setting !== 'string' || !setting.trim()) return null;
  const base = path.resolve(root || '.');
  const resolved = path.resolve(base, setting.trim());
  const inside = resolved === base || resolved.startsWith(base + path.sep);
  if (!inside || (process.platform !== 'win32' && resolved.includes('\\'))) return path.join(getConfigDirectory(env), 'plans');
  return resolved;
}

async function savePlanFile(session, plan) {
  const dir = plansDirectoryFor(session.root, session.settings && session.settings.plansDirectory, session.modelEnv || process.env);
  if (!dir) return null;
  if (!session.planFile || path.dirname(session.planFile) !== dir) {
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const id = String(session.sessionId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 12);
    session.planFile = path.join(dir, 'plan-' + stamp + (id ? '-' + id : '') + '.md');
  }
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(session.planFile, plan.endsWith('\n') ? plan : plan + '\n');
    return session.planFile;
  } catch { return null; }
}

// Plan mode hand-off, like Claude Code's ExitPlanMode: show the plan, and on approval
// leave plan mode so the same turn can start implementing.
export async function exitPlanMode(session, args, context, options) {
  const plan = String(args.plan || '').trim().slice(0, 20000);
  if (!plan) return { approved: false, error: 'Provide the plan to present.' };
  if (options.planOnly) return { approved: false, message: 'This is a plan-only run. Give the plan as your final answer; the user will start implementation separately.' };
  if (!session.permissions || session.permissions.mode !== 'plan') return { approved: true, message: 'Plan mode is not active; continue with the task.' };
  const planFile = await savePlanFile(session, plan);
  const approval = context && context.approval;
  let answer = false;
  if (typeof approval === 'function') {
    answer = await approval('Oasis has a plan and wants to start implementing it:\n\n' + plan + '\n\nLeave plan mode and implement this plan?', true, { tool: 'exit_plan_mode' });
  }
  if (answer === true || answer === 'always') {
    const next = session.prePlanMode && session.prePlanMode !== 'plan' ? session.prePlanMode : 'default';
    session.permissions.setMode(next);
    return { approved: true, mode: next, ...(planFile ? { plan_file: planFile } : {}), message: 'The user approved the plan and plan mode is off (mode: ' + next + '). Implement it now: track the steps with todo_write, make the changes, and verify them.' };
  }
  return { approved: false, ...(planFile ? { plan_file: planFile } : {}), message: 'The user did not approve the plan yet. Stay in plan mode: ask what they would like changed, or refine the plan.' };
}

export function permissionMode(session, options) {
  if (options.planOnly) return 'plan';
  return (session.permissions && session.permissions.mode) || 'default';
}
