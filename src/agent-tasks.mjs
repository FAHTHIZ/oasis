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

export const AGENT_TOOL_DEFINITIONS = [
  { type: 'function', function: { name: 'agent_status', description: 'List subagents started with task (id, type, status, elapsed time), or read one agent\'s status and final report. Set wait_seconds to block until a running agent finishes (up to 600). Background agents report back automatically when they finish, so only wait when the next step needs their result.', parameters: { type: 'object', properties: {
    id: { type: 'string', description: 'Agent id such as agent_1; omit to list all' },
    wait_seconds: { type: 'integer', description: 'Wait up to this many seconds for the agent to finish' }
  }, required: [] } } },
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
  if (!session.agentTasks) session.agentTasks = { next: 1, agents: new Map() };
  return session.agentTasks;
}

export function registerAgent(session, fields) {
  const registry = agentRegistry(session);
  const id = 'agent_' + registry.next++;
  const record = { id, status: 'running', startedAt: Date.now(), finishedAt: null, runs: 1, toolCalls: 0, tokensUsed: 0, recentTools: [], report: '', error: null, ...fields };
  registry.agents.set(id, record);
  return record;
}

export function runningBackgroundCount(session) {
  if (!session.agentTasks) return 0;
  return [...session.agentTasks.agents.values()].filter((agent) => agent.background && agent.status === 'running').length;
}

// Notices reach the model through the session inbox and the UI through onAgentNotice.
export function notifyParent(session, text, record = null) {
  (session.inbox || (session.inbox = [])).push({ text, record });
  if (typeof session.onAgentNotice === 'function') {
    try { session.onAgentNotice(text); } catch {}
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
  if (record.status !== 'running') throw new Error('Agent ' + targetId + ' is not running. Direct teammate messages do not resume finished agents.');
  if (!record.child) throw new Error('Agent ' + targetId + ' has no active conversation to receive a message.');
  const inbox = record.child.inbox || (record.child.inbox = []);
  if (inbox.length >= 100) throw new Error('Agent ' + targetId + ' has too many queued messages; wait for it to catch up.');
  const senderRecord = senderId === 'main' ? null : getAgent(session, senderId);
  const senderLabel = senderRecord ? senderRecord.description : 'main coordinator';
  inbox.push({ text: 'Direct message from teammate ' + senderId + ' (' + senderLabel + '):\n' + message, senderId, kind: 'peer-message' });
  return { delivered: 'queued', from: senderId, to: targetId, status: record.status, message: 'Message queued for ' + targetId + '; it will be delivered at the recipient\'s next model step.' };
}

export function stopAgent(session, args = {}) {
  const record = getAgent(session, args.id);
  if (record.status !== 'running') return { id: record.id, status: record.status, message: 'The agent is not running.' };
  record.cancelRequested = true;
  if (record.controller) record.controller.abort();
  return { id: record.id, status: 'stopping', message: 'Stop requested; the agent will end at its next step.' };
}

export function stopAllAgents(session) {
  if (!session || !session.agentTasks) return;
  for (const record of session.agentTasks.agents.values()) {
    if (record.status === 'running' && record.controller) { record.cancelRequested = true; record.controller.abort(); }
  }
}
