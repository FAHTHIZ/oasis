// Background subagents, like Claude Code's background agents:
//   task { run_in_background: true }  starts a subagent and returns its id at once
//   agent_status { id?, wait_seconds? } lists agents, or reads one (optionally waiting)
//   send_message { id, message }       steers a running agent, or resumes a finished one
//   agent_stop { id }                   cancels a running agent
// Every subagent (foreground or background) is registered so it can be resumed
// later. When a background agent finishes, the parent gets a notice in its
// next model call, and the UI is told through session.onAgentNotice.
//
// Background agents keep running after the parent turn ends, so they cannot
// show approval prompts: actions that would need a prompt are denied unless a
// permission rule or bypass mode already allows them, as in Claude Code.

export const MAX_BACKGROUND_AGENTS = 8;
const MAX_WAIT_SECONDS = 600;
const MAX_TEAMS = 20;
const TEAM_ID = /^team_[1-9]\d{0,5}$/;

export const AGENT_TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'agent_status', description: 'List subagents started with task (id, type, status, elapsed time), or read one agent\'s status and final report. Set wait_seconds to block until a running agent finishes (up to 600). Background agents report back automatically when they finish, so only wait when the next step needs their result.', parameters: { type: 'object', properties: {
    id: { type: 'string', description: 'Agent id such as agent_1; omit to list all' },
    wait_seconds: { type: 'integer', description: 'Wait up to this many seconds for the agent to finish' }
  }, required: [] } } },
  { type: 'function', function: { name: 'agent_events', description: 'Read the recent agent/team activity timeline for this session: worker starts, finishes, failures, cancellations, team lifecycle, and teammate messages. Filter by agent_id or team_id and limit the number of events.', parameters: { type: 'object', properties: {
    agent_id: { type: 'string', description: 'Optional agent ID such as agent_2' },
    team_id: { type: 'string', description: 'Optional team ID such as team_1' },
    limit: { type: 'integer', description: 'Maximum events to return, 1 to 100; defaults to 30' }
  }, required: [] } } },
  { type: 'function', function: { name: 'dispatch_ready_tasks', description: 'Dispatch a bounded wave of ready shared tasks to background general-purpose agents. Each worker uses an isolated Git worktree and must claim its exact task before editing. The dispatcher respects dependencies, active leases, already-running workers, and the background-agent limit. Background workers cannot prompt for per-tool approval; edits or commands that require interactive approval are denied unless the inherited permission mode or explicit allow rules permit them. It does not merge worker branches. Set auto_dispatch=true to keep filling freed slots and dispatch newly unblocked tasks as workers finish; automatic chaining pauses on failed/cancelled workers or tasks they leave incomplete, and only runs while this OASIS session stays alive. Set auto_dispatch=false to stop chaining without cancelling running workers.', parameters: { type: 'object', properties: {
    max_parallel: { type: 'integer', minimum: 1, maximum: 6, description: 'Maximum workers to launch in this wave; defaults to 3' },
    team_id: { type: 'string', description: 'Optional active team ID such as team_1 for named roster and peer messaging' },
    auto_dispatch: { type: 'boolean', description: 'Opt into or stop event-driven chaining of task waves. Omit for a one-time manual wave.' }
  }, required: [] } } },
  { type: 'function', function: { name: 'team_create', description: 'Create a named agent team before launching coordinated workers. Then use the task tool with team_id so members share a named roster and can coordinate directly.', parameters: { type: 'object', properties: {
    name: { type: 'string', description: 'Short unique team name, maximum 100 characters' },
    description: { type: 'string', description: 'Goal or scope for this team, maximum 1,000 characters' }
  }, required: ['name'] } } },
  { type: 'function', function: { name: 'team_status', description: 'Show named agent teams and their member roster, or inspect one team by ID. A shutting-down team becomes closed after all its workers stop.', parameters: { type: 'object', properties: {
    team_id: { type: 'string', description: 'Optional team ID such as team_1; omit to list all teams' }
  }, required: [] } } },
  { type: 'function', function: { name: 'team_shutdown', description: 'Stop a named team: prevent new members, request cancellation of its running agents, and close the team when its workers have exited. Only the main coordinator can shut down teams.', parameters: { type: 'object', properties: {
    team_id: { type: 'string', description: 'Team ID such as team_1' }
  }, required: ['team_id'] } } },
  { type: 'function', function: { name: 'team_send_message', description: 'Send a direct coordination message to another running agent in this task team. Messages are delivered at the recipient\'s next model step. Use this to share findings, ask for an interface decision, or warn about overlapping work. This cannot resume a finished agent or grant it extra permissions.', parameters: { type: 'object', properties: {
    to: { type: 'string', description: 'Target agent ID from agent_status, such as agent_2' },
    message: { type: 'string', description: 'Coordination message, maximum 20,000 characters' }
  }, required: ['to', 'message'] } } },
  { type: 'function', function: { name: 'send_message', description: 'Send a message to a subagent by id. A running agent sees it at its next step (use this to steer or add requirements). A finished agent resumes in the background with its full previous context, so follow-up work does not start from scratch.', parameters: { type: 'object', properties: {
    id: { type: 'string', description: 'Agent id from task or agent_status' },
    message: { type: 'string', description: 'Instructions or information for the agent' }
  }, required: ['id', 'message'] } } },
  { type: 'function', function: { name: 'agent_stop', description: 'Stop a running background subagent.', parameters: { type: 'object', properties: {
    id: { type: 'string' }
  }, required: ['id'] } } }
];

export const AGENT_TOOL_NAMES = new Set(AGENT_TOOL_DEFINITIONS.map((tool) => tool.function.name));

export function agentRegistry(session) {
  if (!session.agentTasks) session.agentTasks = { next: 1, agents: new Map(), nextTeam: 1, teams: new Map(), events: [], nextEventId: 1 };
  const registry = session.agentTasks;
  if (!(registry.agents instanceof Map)) registry.agents = new Map();
  if (!(registry.teams instanceof Map)) registry.teams = new Map();
  if (!Array.isArray(registry.events)) registry.events = [];
  if (!Number.isSafeInteger(registry.nextEventId) || registry.nextEventId < 1) registry.nextEventId = registry.events.reduce((max, event) => Math.max(max, Number(event.id) || 0), 0) + 1;
  if (!Number.isSafeInteger(registry.nextTeam) || registry.nextTeam < 1) registry.nextTeam = 1;
  return registry;
}

function isMainCoordinator(session) {
  return !session.agentId || session.agentId === 'main';
}

export function recordAgentEvent(session, type, fields = {}) {
  const registry = agentRegistry(session);
  const event = {
    id: registry.nextEventId++,
    at: new Date().toISOString(),
    type: String(type || 'agent.event').slice(0, 80),
    actor: String(session.agentId || 'main').slice(0, 100),
    ...(fields.agentId ? { agent_id: String(fields.agentId).slice(0, 100) } : {}),
    ...(fields.teamId ? { team_id: String(fields.teamId).slice(0, 100) } : {}),
    ...(fields.description ? { description: String(fields.description).slice(0, 200) } : {}),
    ...(fields.detail ? { detail: String(fields.detail).slice(0, 500) } : {})
  };
  registry.events.push(event);
  if (registry.events.length > 500) registry.events.splice(0, registry.events.length - 500);
  // Observers (such as the authenticated browser run monitor) receive a bounded,
  // structured copy while the in-session timeline remains the source of truth.
  // A UI observer must never be able to interrupt agent orchestration.
  if (typeof session.onAgentEvent === 'function') {
    try { session.onAgentEvent(event); } catch {}
  }
  return event;
}

export function agentEvents(session, args = {}) {
  if (!isMainCoordinator(session)) throw new Error('Only the main coordinator can inspect the full agent activity timeline.');
  const registry = agentRegistry(session);
  const agentId = String(args.agent_id || '').trim();
  const teamId = String(args.team_id || '').trim();
  const limit = Math.max(1, Math.min(100, Number.parseInt(args.limit, 10) || 30));
  const filtered = registry.events.filter((event) => (!agentId || event.agent_id === agentId) && (!teamId || event.team_id === teamId));
  const events = filtered.slice(-limit);
  return { events, total: filtered.length, returned: events.length, truncated: filtered.length > events.length };
}

export function getAgentTeam(session, idValue) {
  const id = String(idValue || '').trim();
  if (!TEAM_ID.test(id)) throw new Error('team_id must look like team_1.');
  const team = agentRegistry(session).teams.get(id);
  if (!team) throw new Error('No agent team with ID ' + id + '. Use team_status to list teams.');
  return team;
}

function refreshTeam(session, team) {
  const registry = agentRegistry(session);
  const members = team.members.map((id) => registry.agents.get(id)).filter(Boolean);
  if (team.status === 'shutting_down' && !members.some((member) => member.status === 'running')) {
    team.status = 'closed';
    team.closedAt ||= new Date().toISOString();
  }
  return members;
}

function summarizeTeam(session, team) {
  const members = refreshTeam(session, team);
  const roster = members.map((member) => ({
    id: member.id,
    description: member.description,
    agent: member.type,
    status: member.status,
    background: Boolean(member.background),
    elapsed: elapsed(member)
  }));
  return {
    id: team.id,
    name: team.name,
    description: team.description,
    status: team.status,
    created_by: team.createdBy,
    created_at: team.createdAt,
    closed_at: team.closedAt,
    member_count: roster.length,
    running: roster.filter((member) => member.status === 'running').length,
    members: roster
  };
}

export function listAgentTeams(session) {
  return [...agentRegistry(session).teams.values()].map((team) => summarizeTeam(session, team));
}

export function createAgentTeam(session, args = {}) {
  if (!isMainCoordinator(session)) throw new Error('Only the main coordinator can create agent teams.');
  const name = String(args.name || '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const description = String(args.description || '').trim().slice(0, 1000);
  if (!name) throw new Error('team_create needs a non-empty name.');
  const registry = agentRegistry(session);
  if (registry.teams.size >= MAX_TEAMS) throw new Error('This session is limited to ' + MAX_TEAMS + ' named agent teams.');
  if ([...registry.teams.values()].some((team) => team.name.toLowerCase() === name.toLowerCase() && team.status !== 'closed')) {
    throw new Error('An active team named ' + JSON.stringify(name) + ' already exists.');
  }
  const id = 'team_' + registry.nextTeam++;
  const team = { id, name, description, status: 'active', createdBy: 'main', createdAt: new Date().toISOString(), closedAt: null, members: [] };
  registry.teams.set(id, team);
  recordAgentEvent(session, 'team.created', { teamId: id, description: name, detail: description });
  return { team: summarizeTeam(session, team), message: 'Created ' + id + '. Launch coordinated workers with the task tool and team_id: ' + id + '.' };
}

export function agentTeamStatus(session, args = {}) {
  if (args.team_id) return { team: summarizeTeam(session, getAgentTeam(session, args.team_id)) };
  const teams = listAgentTeams(session);
  return { teams, total: teams.length, active: teams.filter((team) => team.status === 'active').length };
}

export function shutdownAgentTeam(session, args = {}) {
  if (!isMainCoordinator(session)) throw new Error('Only the main coordinator can shut down agent teams.');
  const team = getAgentTeam(session, args.team_id);
  if (team.status === 'closed') return { team: summarizeTeam(session, team), stop_requested: 0, message: team.name + ' is already closed.' };
  team.status = 'shutting_down';
  recordAgentEvent(session, 'team.shutdown_requested', { teamId: team.id, description: team.name });
  let stopRequested = 0;
  for (const memberId of team.members) {
    const member = agentRegistry(session).agents.get(memberId);
    if (!member || member.status !== 'running') continue;
    member.cancelRequested = true;
    if (member.controller) member.controller.abort();
    stopRequested += 1;
  }
  const summary = summarizeTeam(session, team);
  return { team: summary, stop_requested: stopRequested, message: 'Shutdown requested for ' + team.name + '. No new workers can join; the team closes when active workers exit.' };
}

export function registerAgent(session, fields) {
  const registry = agentRegistry(session);
  const teamId = fields.teamId ? String(fields.teamId).trim() : '';
  const team = teamId ? getAgentTeam(session, teamId) : null;
  if (team && team.status !== 'active') throw new Error('Cannot add an agent to team ' + team.id + ' because it is ' + team.status + '.');
  const id = 'agent_' + registry.next++;
  const record = { id, status: 'running', startedAt: Date.now(), finishedAt: null, runs: 1, toolCalls: 0, tokensUsed: 0, recentTools: [], report: '', error: null, ...fields, teamId: teamId || null };
  registry.agents.set(id, record);
  if (team) team.members.push(id);
  recordAgentEvent(session, 'agent.started', { agentId: id, teamId: teamId || undefined, description: record.description || record.type || id });
  if (record.sharedTaskId) recordAgentEvent(session, 'task.dispatched', { agentId: id, teamId: teamId || undefined, description: record.sharedTaskId, detail: record.description || '' });
  return record;
}

export function runningBackgroundCount(session) {
  if (!session.agentTasks) return 0;
  return [...session.agentTasks.agents.values()].filter((agent) => agent.background && agent.status === 'running').length;
}

// Notices reach the model through the session inbox and the UI through onAgentNotice.
export function notifyParent(session, text, record = null) {
  (session.inbox || (session.inbox = [])).push({ text, record, kind: record ? 'agent-notice' : 'agent-dispatch' });
  if (typeof session.onAgentNotice === 'function') {
    try { session.onAgentNotice(text); } catch {}
  }
  // A finished background agent wakes an idle interactive session (Claude Code behavior).
  if (record && typeof session.onBackgroundEvent === 'function') {
    try { session.onBackgroundEvent({ kind: 'agent-notice', id: record.id, description: 'agent "' + record.description + '" ' + record.status }); } catch {}
  }
}

// Moves queued notices/messages into the conversation. Returns the text added.
export function drainInbox(session) {
  if (!session.inbox || !session.inbox.length) return '';
  // Skip finish notices for agents whose report the model already read via agent_status.
  const entries = session.inbox.splice(0).filter((entry) => !(entry.record && entry.record.noticeRead));
  if (!entries.length) return '';
  const text = entries.map((entry) => entry.text).join('\n\n');
  return '<system-reminder>\n' + text.slice(0, 20000) + '\n</system-reminder>';
}

function elapsed(record) {
  const seconds = Math.round(((record.finishedAt || Date.now()) - record.startedAt) / 1000);
  return seconds < 90 ? seconds + 's' : Math.round(seconds / 60) + 'm';
}

export function summarizeAgent(record, { full = false } = {}) {
  const out = { id: record.id, agent: record.type, description: record.description, status: record.status, background: Boolean(record.background), elapsed: elapsed(record), runs: record.runs, toolCalls: record.toolCalls };
  if (record.teamId) out.team_id = record.teamId;
  if (record.sharedTaskId) out.task_id = record.sharedTaskId;
  if (record.status === 'running' && record.recentTools.length) out.recentTools = record.recentTools.slice(-5);
  const queuedMessages = Array.isArray(record.child && record.child.inbox) ? record.child.inbox.length : 0;
  if (queuedMessages) out.queuedMessages = queuedMessages;
  if (record.worktree) out.worktree = record.worktree;
  if (record.error) out.error = record.error;
  if (full && record.status !== 'running') out.report = record.report;
  else if (record.report) out.reportPreview = record.report.slice(0, 300);
  return out;
}

export function listAgents(session) {
  if (!session.agentTasks) return [];
  return [...session.agentTasks.agents.values()].map((record) => summarizeAgent(record));
}

export function getAgent(session, id) {
  const record = session.agentTasks && session.agentTasks.agents.get(String(id || '').trim());
  if (!record) throw new Error('No subagent with id ' + JSON.stringify(id) + '. Use agent_status to list agents.');
  return record;
}

export async function agentStatus(session, args = {}, signal) {
  if (!args.id) {
    const agents = listAgents(session);
    return { agents, running: agents.filter((agent) => agent.status === 'running').length, message: agents.length ? undefined : 'No subagents have been started in this session.' };
  }
  const record = getAgent(session, args.id);
  const wait = Math.max(0, Math.min(MAX_WAIT_SECONDS, Number.parseInt(args.wait_seconds, 10) || 0));
  if (wait && record.status === 'running' && record.promise) {
    let timer;
    let onAbort;
    await Promise.race([
      record.promise.catch(() => {}),
      new Promise((resolve) => { timer = setTimeout(resolve, wait * 1000); timer.unref?.(); }),
      new Promise((resolve) => { if (signal) { onAbort = resolve; signal.addEventListener('abort', onAbort, { once: true }); } })
    ]);
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
  // The parent has now read this result, so drop its pending finish notice.
  if (record.status !== 'running') record.noticeRead = true;
  return summarizeAgent(record, { full: true });
}

export function sendTeamMessage(session, args = {}) {
  const senderId = String(session.agentId || 'main');
  const targetId = String(args.to || '').trim();
  if (!targetId) throw new Error('team_send_message needs a target agent ID.');
  if (targetId === senderId) throw new Error('An agent cannot send a teammate message to itself.');
  const message = String(args.message || '').trim();
  if (!message) throw new Error('team_send_message needs a message.');
  if (message.length > 20000) throw new Error('Messages must be 20,000 characters or fewer.');
  const record = getAgent(session, targetId);
  const senderRecord = senderId === 'main' ? null : getAgent(session, senderId);
  if (senderRecord && senderRecord.teamId !== record.teamId) {
    throw new Error('Direct teammate messages require both agents to belong to the same team. Target ' + targetId + ' is ' + (record.teamId || 'not assigned to a named team') + '.');
  }
  if (record.status !== 'running') throw new Error('Agent ' + targetId + ' is not running. Direct teammate messages do not resume finished agents.');
  if (!record.child) throw new Error('Agent ' + targetId + ' has no active conversation to receive a message.');
  const inbox = record.child.inbox || (record.child.inbox = []);
  if (inbox.length >= 100) throw new Error('Agent ' + targetId + ' has too many queued messages; wait for it to catch up.');
  const senderLabel = senderRecord ? senderRecord.description : 'main coordinator';
  inbox.push({ text: 'Direct message from teammate ' + senderId + ' (' + senderLabel + '):\n' + message, senderId, kind: 'peer-message' });
  recordAgentEvent(session, 'agent.message_queued', { agentId: targetId, teamId: record.teamId || undefined, description: senderId + ' → ' + targetId, detail: message });
  return { delivered: 'queued', from: senderId, to: targetId, status: record.status, message: 'Message queued for ' + targetId + '; it will be delivered at the recipient\'s next model step.' };
}

export function stopAgent(session, args = {}) {
  const record = getAgent(session, args.id);
  if (record.status !== 'running') return { id: record.id, status: record.status, message: 'The agent is not running.' };
  record.cancelRequested = true;
  if (record.controller) record.controller.abort();
  recordAgentEvent(session, 'agent.stop_requested', { agentId: record.id, teamId: record.teamId || undefined, description: record.description });
  return { id: record.id, status: 'stopping', message: 'Stop requested; the agent will end at its next step.' };
}

export function stopAllAgents(session) {
  if (!session || !session.agentTasks) return;
  for (const record of session.agentTasks.agents.values()) {
    if (record.status === 'running' && record.controller) { record.cancelRequested = true; record.controller.abort(); }
  }
}
