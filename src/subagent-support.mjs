// Subagent helpers that do not depend on the agent loop: step and depth limits,
// definition context (preloaded skills, agent memory), the stall monitor, the
// resume-worktree check and the background usage sink. The runtime that drives
// child turns stays in agent.mjs.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { loadSkillText } from './tools.mjs';
import { loadAgentMemory, agentMemoryDirectory } from './subagents.mjs';

export function subagentStepLimit(record, options) {
  const limits = [record.maxTurns, options.subagentMaxSteps].map(Number).filter((value) => Number.isInteger(value) && value > 0);
  return limits.length ? Math.min(...limits) : undefined;
}

// Prompt sections that come from the agent definition: preloaded skills and the
// agent's persistent memory. Missing skills are reported, not fatal.
export async function subagentDefinitionContext(parent, agent, options) {
  const env = options.env || process.env;
  const sections = [];
  if (Array.isArray(agent.skills) && agent.skills.length) {
    let budget = 64 * 1024;
    const loaded = [];
    const missing = [];
    for (const name of agent.skills) {
      try {
        const text = String(await loadSkillText(parent.root, name, { env })).slice(0, 24 * 1024);
        if (text.length > budget) { missing.push(name + ' (over the preload budget)'); continue; }
        budget -= text.length;
        loaded.push('<skill name="' + name + '">\n' + text + '\n</skill>');
      } catch { missing.push(name); }
    }
    if (loaded.length) sections.push('PRELOADED SKILLS: follow these as part of your instructions.\n' + loaded.join('\n'));
    if (missing.length) sections.push('These skills from your definition could not be loaded: ' + missing.join(', ') + '.');
  }
  if (agent.memory) {
    const dir = agentMemoryDirectory(agent, parent.root, env);
    const memory = await loadAgentMemory(agent, parent.root, env);
    sections.push('AGENT MEMORY (' + agent.memory + ' scope, ' + dir + '): notes you kept from earlier runs.' + (memory ? '\n<agent-memory>\n' + memory + '\n</agent-memory>' : ' MEMORY.md is empty so far.') + '\nBefore finishing, record durable lessons (patterns, pitfalls, file locations) concisely in MEMORY.md there when you are able to write it; keep it under 200 lines.');
  }
  return sections;
}

export async function verifyResumeWorktree(root, saved, env) {
  const relative = String(saved.relative || '').replace(/\\/g, '/');
  if (!relative.startsWith('.oasis/worktrees/') || relative.split('/').some((part) => part === '..' || part === '.' || !part) || relative.split('/').length !== 3) throw new Error('its saved worktree path is not valid.');
  const rootReal = await realpath(root);
  const absolute = path.join(rootReal, ...relative.split('/'));
  let info;
  try { info = await lstat(absolute); } catch { throw new Error('its worktree ' + relative + ' no longer exists.'); }
  if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(absolute)) !== absolute) throw new Error('its worktree ' + relative + ' is not a plain directory.');
  const run = (args) => new Promise((resolve, reject) => {
    execFile('git', args, { cwd: absolute, env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: 15000, maxBuffer: 1024 * 1024 }, (error, stdout) => error ? reject(error) : resolve(String(stdout).trim()));
  });
  let top, branch;
  try { [top, branch] = await Promise.all([run(['rev-parse', '--show-toplevel']), run(['symbolic-ref', '--quiet', '--short', 'HEAD'])]); } catch { throw new Error('its worktree ' + relative + ' is not a git checkout on a branch.'); }
  if (path.resolve(await realpath(top)) !== absolute) throw new Error('its worktree ' + relative + ' is not its own git worktree.');
  if (branch !== saved.branch) throw new Error('its worktree is on branch ' + branch + ', not ' + saved.branch + '.');
  try { await run(['merge-base', '--is-ancestor', saved.base, 'HEAD']); } catch { throw new Error('its worktree no longer contains the commit it started from.'); }
  return { name: relative.split('/').pop(), branch: saved.branch, path: absolute, relative, base: saved.base };
}

// Usage from background agents: the nearest session up the chain with an
// onBackgroundUsage function (child sessions point back at their parent).
export function backgroundUsageSink(session) {
  for (let current = session, depth = 0; current && depth < 20; current = current.parentSessionRef, depth++) {
    if (typeof current.onBackgroundUsage === 'function') return current.onBackgroundUsage;
  }
  return null;
}

// Nested delegation (as in Hermes' max_spawn_depth): 1, the default, means only the
// main agent delegates. 2 or 3 lets writing subagents launch their own; the
// background-agent cap stays shared across the whole tree.
export function subagentMaxDepth(session, env = process.env) {
  const raw = env.OASIS_SUBAGENT_MAX_DEPTH !== undefined && env.OASIS_SUBAGENT_MAX_DEPTH !== '' ? env.OASIS_SUBAGENT_MAX_DEPTH : session && session.subagentMaxDepth;
  const value = Number(raw);
  return Number.isInteger(value) ? Math.min(3, Math.max(1, value)) : 1;
}

export function subagentStallLimits(parent, env = process.env) {
  const raw = env.OASIS_SUBAGENT_STALL_SECONDS !== undefined && env.OASIS_SUBAGENT_STALL_SECONDS !== '' ? env.OASIS_SUBAGENT_STALL_SECONDS : parent && parent.subagentStallSeconds;
  const idle = raw === undefined || raw === null || raw === '' ? 450 : Number(raw);
  if (!Number.isFinite(idle) || idle <= 0) return null;
  // The in-tool limit keeps Hermes' ratio (450s idle, 1200s inside a tool).
  return { idleMs: idle * 1000, inToolMs: Math.round(idle * 1000 * 1200 / 450) };
}

export function watchForStall(parent, record, env) {
  const limits = subagentStallLimits(parent, env);
  if (!limits) return () => {};
  record.lastActivityAt = Date.now();
  record.inTool = false;
  const timer = setInterval(() => {
    if (record.status !== 'running') return;
    const idle = Date.now() - (record.lastActivityAt || 0);
    const limit = record.inTool ? limits.inToolMs : limits.idleMs;
    if (idle < limit) return;
    record.stalled = 'No activity for ' + Math.round(idle / 1000) + 's' + (record.inTool ? ' while a tool was running' : '') + '; the agent was stopped as stalled.';
    try { record.controller.abort(); } catch {}
  }, Math.max(250, Math.min(15000, Math.floor(limits.idleMs / 4))));
  if (typeof timer.unref === 'function') timer.unref();
  return () => clearInterval(timer);
}
