// Specialists the agent defines for itself while it works.
//
// Agent definition files (.oasis/agents/*.md, .claude/agents/*.md, ...) are
// read when a session starts. Two gaps follow from that: the main agent cannot
// shape a specialist for a job it only discovers mid-task, and a definition file
// it writes during the session is invisible until the next one.
//
//   - agent_define registers a specialist for this session: a name, when to use
//     it, its instructions, and optionally a narrower tool list, a model, an
//     effort level, a turn limit and the report checks (code, research,
//     analysis). It then appears in the task tool like any other agent and is
//     saved with the session.
//   - When task names an agent that is not known, the definition files are read
//     again once, so a file written during the session works straight away.
//
// What a definition cannot do: it is built from a fixed list of fields, so it
// carries no hooks, MCP servers or permission mode, and a subagent's tools are
// always limited to its parent's (src/agent-subagents.mjs). Names of agents
// from files, plugins, --agents or the built-ins cannot be replaced.

import { BUILTIN_AGENTS, loadAgentDefinitions, normalizeAgentDefinition, taskToolDefinition } from './subagents.mjs';

export const SESSION_AGENT_SOURCE = 'session:agent_define';
const MAX_DEFINED = 20;
const MAX_INSTRUCTIONS = 20_000;
const NAME = /^[a-z][a-z0-9_-]{1,40}$/;
const EFFORTS = new Set(['low', 'medium', 'high', 'max']);
const DOMAINS = new Set(['code', 'research', 'analysis']);

export const AGENT_DEFINE_TOOL_DEFINITION = { type: 'function', function: { name: 'agent_define', description: 'Define a specialist subagent for this session, then launch it with task subagent_type set to its name, as often as needed and in parallel. Use it when several tasks need the same expertise or rules (a reviewer with a checklist, a researcher held to primary sources, a tester for one framework): write the instructions once instead of repeating them in every task prompt. tools narrows what it may use (it never gets more than you have). The definition lasts for this session; pass remove to delete one.', parameters: { type: 'object', properties: {
  name: { type: 'string', description: 'Lowercase id such as api-reviewer (2-41 characters: letters, digits, - and _)' },
  description: { type: 'string', description: 'When to use this agent, one or two sentences (shown in the task tool)' },
  instructions: { type: 'string', description: 'Its system instructions: role, method, rules, and what its report must contain' },
  tools: { type: 'array', items: { type: 'string' }, description: 'Optional allowlist of tool names, such as ["read_file", "grep", "glob_files"]; omit for all of your tools' },
  disallowed_tools: { type: 'array', items: { type: 'string' }, description: 'Optional tool names it must not use' },
  model: { type: 'string', description: 'Optional model id; omit to use the session model' },
  effort: { type: 'string', enum: ['low', 'medium', 'high', 'max'] },
  max_turns: { type: 'integer', minimum: 1, maximum: 400 },
  domains: { type: 'array', items: { type: 'string', enum: ['code', 'research', 'analysis'] }, description: 'What its reports are checked against when they come back' },
  remove: { type: 'boolean', description: 'Delete the session agent with this name instead of defining it' }
}, required: ['name'] } } };

function text(value, max) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim().slice(0, max) : '';
}

function names(value, max = 60) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => text(item, 80)).filter((item) => /^[A-Za-z][\w.:-]{0,79}$/.test(item)))].slice(0, max);
}

/** The saved form of one definition: only the fields agent_define accepts. */
function cleanSpec(raw = {}) {
  const spec = {
    description: text(raw.description, 600),
    instructions: text(raw.instructions, MAX_INSTRUCTIONS)
  };
  const tools = names(raw.tools);
  const disallowed = names(raw.disallowed_tools);
  if (tools.length) spec.tools = tools;
  if (disallowed.length) spec.disallowed_tools = disallowed;
  const model = text(raw.model, 200);
  if (model && !/^inherit$/i.test(model)) spec.model = model;
  const effort = text(raw.effort, 10).toLowerCase();
  if (EFFORTS.has(effort)) spec.effort = effort;
  const turns = Number(raw.max_turns);
  if (Number.isInteger(turns) && turns >= 1) spec.max_turns = Math.min(400, turns);
  const domains = (Array.isArray(raw.domains) ? raw.domains : []).map((item) => String(item).toLowerCase()).filter((item) => DOMAINS.has(item));
  if (domains.length) spec.domains = [...new Set(domains)];
  return spec;
}

/** Saved definitions, validated: { name: spec }, at most 20. */
export function sanitizeDefinedAgents(value) {
  const out = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [rawName, raw] of Object.entries(value)) {
    const name = String(rawName).toLowerCase();
    if (!NAME.test(name) || Object.hasOwn(BUILTIN_AGENTS, name) || !raw || typeof raw !== 'object') continue;
    const spec = cleanSpec(raw);
    if (!spec.description || !spec.instructions) continue;
    out[name] = spec;
    if (Object.keys(out).length >= MAX_DEFINED) break;
  }
  return out;
}

export function sessionAgentDefinition(name, spec) {
  const definition = normalizeAgentDefinition({
    description: spec.description,
    ...(spec.tools ? { tools: spec.tools } : {}),
    ...(spec.disallowed_tools ? { disallowedTools: spec.disallowed_tools } : {}),
    ...(spec.model ? { model: spec.model } : {}),
    ...(spec.effort ? { effort: spec.effort } : {}),
    ...(spec.max_turns ? { maxTurns: spec.max_turns } : {}),
    ...(spec.domains ? { domains: spec.domains } : {})
  }, spec.instructions, { name, source: SESSION_AGENT_SOURCE });
  return definition;
}

/** Rebuilds the task tool so its agent list matches session.agents. */
export function refreshTaskTool(session) {
  if (!session || !Array.isArray(session.toolDefinitions)) return;
  const index = session.toolDefinitions.findIndex((tool) => tool && tool.function && tool.function.name === 'task');
  if (index < 0) return;
  session.toolDefinitions = session.toolDefinitions.slice();
  session.toolDefinitions[index] = taskToolDefinition(session.agents || BUILTIN_AGENTS);
}

/** Adds saved session agents to session.agents (at session start or restore). */
export function applyDefinedAgents(session) {
  if (!session || !session.agents) return;
  let changed = false;
  for (const [name, spec] of Object.entries(session.definedAgents || {})) {
    const existing = session.agents[name];
    if (existing && existing.source !== SESSION_AGENT_SOURCE) continue;
    session.agents[name] = sessionAgentDefinition(name, spec);
    changed = true;
  }
  if (changed) refreshTaskTool(session);
}

function knownToolNames(session) {
  const known = new Set();
  for (const tool of session.toolDefinitions || []) if (tool && tool.function) known.add(tool.function.name);
  if (session.deferredTools instanceof Map) for (const name of session.deferredTools.keys()) known.add(name);
  return known;
}

/**
 * agent_define. modelAllowed(model) applies the session's model policy.
 * Returns what was defined, for the model.
 */
export function defineSessionAgent(session, args = {}, { modelAllowed = () => true } = {}) {
  const name = String(args.name || '').trim().toLowerCase();
  if (!NAME.test(name)) throw new Error('agent_define needs a name of 2-41 lowercase letters, digits, - or _, starting with a letter.');
  session.agents = session.agents || { ...BUILTIN_AGENTS };
  session.definedAgents = session.definedAgents || {};
  const existing = session.agents[name];
  if (existing && existing.source !== SESSION_AGENT_SOURCE) {
    throw new Error('An agent named ' + name + ' already exists (' + (existing.source || 'built-in') + '); it cannot be replaced from here. Use it as it is, or pick another name.');
  }
  if (args.remove === true) {
    if (!existing) throw new Error('No session agent named ' + name + '.');
    delete session.agents[name];
    delete session.definedAgents[name];
    refreshTaskTool(session);
    return { removed: name };
  }
  const spec = cleanSpec(args);
  if (!spec.description) throw new Error('agent_define needs a description: when should this agent be used?');
  if (!spec.instructions) throw new Error('agent_define needs instructions: the role, method and what its report must contain.');
  if (typeof args.instructions === 'string' && args.instructions.trim().length > MAX_INSTRUCTIONS) throw new Error('Instructions must be ' + MAX_INSTRUCTIONS.toLocaleString('en-US') + ' characters or fewer.');
  if (!existing && Object.keys(session.definedAgents).length >= MAX_DEFINED) throw new Error('This session already has ' + MAX_DEFINED + ' defined agents; remove one first (agent_define with remove).');
  const known = knownToolNames(session);
  const unknown = [...(spec.tools || []), ...(spec.disallowed_tools || [])].filter((tool) => !known.has(tool));
  if (unknown.length) throw new Error('Unknown tool' + (unknown.length === 1 ? ' ' : 's ') + unknown.join(', ') + '. Use names of tools you have, such as read_file, grep, glob_files, run_command, edit_file, fetch_url.');
  if (spec.tools && spec.tools.includes('task')) throw new Error('A defined agent cannot be given the task tool; nesting follows subagentMaxDepth for every agent.');
  if (spec.model && !modelAllowed(spec.model)) throw new Error('The model ' + spec.model + ' is not allowed by this session\'s model policy (availableModels or deniedModels). Omit model to use the session model.');
  session.definedAgents[name] = spec;
  session.agents[name] = sessionAgentDefinition(name, spec);
  refreshTaskTool(session);
  return {
    defined: name,
    replaced: Boolean(existing),
    tools: spec.tools || 'all of your tools',
    ...(spec.model ? { model: spec.model } : {}),
    note: 'Launch it with task (subagent_type "' + name + '"). It lasts for this session. To keep it for future sessions, save it as .oasis/agents/' + name + '.md: front matter with name, description and tools, then the instructions.'
  };
}

/**
 * task named an agent this session does not know: read the definition files
 * again (one may have been written since the session started) and add any new
 * ones. Existing definitions are kept as they are. Returns true when the agent
 * is now known.
 */
export async function reloadAgentFiles(session, type, { env = process.env } = {}) {
  if (!session || !session.root) return false;
  let loaded;
  try { loaded = await loadAgentDefinitions(session.root, { env }); } catch { return false; }
  let added = false;
  session.agents = session.agents || { ...BUILTIN_AGENTS };
  for (const [name, definition] of Object.entries(loaded)) {
    if (session.agents[name]) continue;
    session.agents[name] = definition;
    added = true;
  }
  if (added) refreshTaskTool(session);
  const wanted = String(type || '').toLowerCase();
  return Object.keys(session.agents).some((name) => name.toLowerCase() === wanted);
}
