// Subagent helpers that do not depend on the agent loop: step and depth limits,
// definition context (preloaded skills, agent memory), the stall monitor, the
// resume-worktree check and the background usage sink. The runtime that drives
// child turns stays in agent.mjs.
import path from 'node:path';
import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { loadSkillText } from './tools.mjs';
import { loadAgentMemory, agentMemoryDirectory } from './subagents.mjs';
import { normalizeHooks, mergeHooks } from './settings.mjs';

// The parent's hooks plus those in the agent's front matter. As in Claude Code,
// a Stop hook in an agent file runs as SubagentStop. Hooks run commands, so a
// project agent file only adds them in a trusted workspace, the same rule as
// project settings.
export function agentScopedHooks(parent, agent) {
  const base = parent.hooks || {};
  if (!agent || !agent.hooks) return base;
  // disableAllHooks / allowManagedHooksOnly also block hooks declared in agent files.
  if (parent.settings && parent.settings.hooksDisabled) return base;
  if (String(agent.source || '').startsWith('project') && !(parent.settings && parent.settings.trusted)) return base;
  const raw = { ...agent.hooks };
  if (raw.Stop) { raw.SubagentStop = [...(Array.isArray(raw.SubagentStop) ? raw.SubagentStop : []), ...(Array.isArray(raw.Stop) ? raw.Stop : [])]; delete raw.Stop; }
  const extra = normalizeHooks(raw);
  if (!Object.keys(extra).length) return base;
  const merged = Object.fromEntries(Object.entries(base).map(([event, groups]) => [event, [...groups]]));
  mergeHooks(merged, extra, 'agent:' + agent.name);
  return merged;
}

// Inline MCP servers from the agent file. They start third-party code, so a
// project agent file only gets them in a trusted workspace (like .mcp.json).
export function agentMcpSpec(parent, agent) {
  const inline = agent && agent.mcpServers && agent.mcpServers.inline;
  if (!inline || !Object.keys(inline).length) return null;
  if (String(agent.source || '').startsWith('project') && !(parent.settings && parent.settings.trusted)) return null;
  return inline;
}

// Connects the agent's own servers into its (copied) client and tool maps.
// Names already used by the parent keep the parent's connection.
export async function connectAgentMcp(child, env = process.env) {
  if (!child.agentMcpSpec || child.agentMcpClients) return { definitions: [], failures: [] };
  const { parseMcpServerEntries } = await import('./mcp-project.mjs');
  const { connectMcpServers, mcpToolDefinitions } = await import('./mcp.mjs');
  const parsed = parseMcpServerEntries({ mcpServers: child.agentMcpSpec }, env, 'agent');
  const servers = parsed.servers.filter((server) => !child.mcpClients.has(server.name)).map((server) => ({ ...server, source: 'agent' }));
  const { clients, failures } = servers.length ? await connectMcpServers({ root: child.root, env, policy: child.settings && child.settings.mcpPolicy, skipUser: true, extraServers: servers }) : { clients: new Map(), failures: [] };
  child.agentMcpClients = clients;
  for (const [name, client] of clients) child.mcpClients.set(name, client);
  const { definitions, map } = mcpToolDefinitions(clients);
  for (const [name, entry] of map) child.mcpToolMap.set(name, entry);
  return { definitions, failures: [...parsed.failures, ...failures] };
}

export function closeAgentMcp(child) {
  if (!child || !child.agentMcpClients) return;
  for (const [name, client] of child.agentMcpClients) {
    try { client.close(); } catch {}
    child.mcpClients.delete(name);
  }
  child.agentMcpClients = null;
}

// The parent's system prompt without the project instruction block, for agents
// with omitClaudeMd.
export function withoutProjectInstructions(base, projectContext) {
  const text = String(base || '');
  const context = String(projectContext || '');
  if (!context) return text;
  for (const header of ['Project instructions follow. Treat them as project context; the safety rules above still apply.\n\n', 'Project instructions follow; the rules above still apply.\n\n']) {
    const start = text.indexOf(header);
    if (start < 0) continue;
    const after = start + header.length;
    // The compact prompt trims long instructions; drop up to the next section either way.
    const end = text.startsWith(context, after) ? after + context.length : (() => { const next = text.indexOf('\n\n', after); return next < 0 ? text.length : next; })();
    return text.slice(0, start) + 'Project instruction files are omitted for this agent.' + text.slice(end);
  }
  return text;
}

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

// Nested delegation: the number of subagent layers below the main conversation.
// Like Claude Code, the default is 3; 1 turns nesting off. Read by
// OASIS_SUBAGENT_MAX_DEPTH, then CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH, then the
// subagentMaxDepth setting. The background-agent cap is shared across the tree.
const DEFAULT_SUBAGENT_MAX_DEPTH = 3;
export function subagentMaxDepth(session, env = process.env) {
  const pick = (value) => value !== undefined && value !== null && value !== '' ? value : undefined;
  const raw = pick(env.OASIS_SUBAGENT_MAX_DEPTH) ?? pick(env.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH) ?? (session && session.subagentMaxDepth);
  const value = Number(raw);
  return raw !== undefined && Number.isInteger(value) ? Math.min(5, Math.max(1, value)) : DEFAULT_SUBAGENT_MAX_DEPTH;
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
