// Control room view model: turns the /api/control-room snapshot into rows
// for app/control-room.mjs. Pure, so it is unit tested without a DOM.

export const AGENT_STATUS_TEXT = Object.freeze({
  running: 'Working', quiet: 'No recent activity', completed: 'Done', failed: 'Failed',
  cancelled: 'Stopped', interrupted: 'Interrupted', stalled: 'Stalled', stopping: 'Stopping'
});

export function formatTokens(value) {
  const number = Number(value) || 0;
  if (number >= 1e6) return (number / 1e6).toFixed(number >= 1e7 ? 0 : 1) + 'M';
  if (number >= 1e3) return (number / 1e3).toFixed(number >= 1e4 ? 0 : 1) + 'k';
  return String(Math.round(number));
}

export function formatCost(value) {
  const number = Number(value) || 0;
  if (!number) return '$0';
  return number < 0.01 ? '<$0.01' : '$' + number.toFixed(number < 10 ? 2 : 0);
}

export function formatBytes(value) {
  const number = Number(value) || 0;
  if (number >= 1024 ** 3) return (number / 1024 ** 3).toFixed(1) + ' GB';
  return Math.round(number / 1024 ** 2) + ' MB';
}

export function ago(ms, now = Date.now()) {
  if (!ms) return '';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
  return Math.round(seconds / 86400) + 'd ago';
}

function tone(status) {
  if (status === 'running') return 'running';
  if (status === 'quiet' || status === 'stalled' || status === 'waiting') return 'waiting';
  if (status === 'failed') return 'failed';
  if (status === 'completed') return 'completed';
  return 'idle';
}

/** The headline numbers. */
export function controlRoomKpis(snapshot) {
  const s = snapshot && snapshot.summary || {};
  const r = snapshot && snapshot.resources || {};
  const used = r.memoryTotal ? (r.memoryTotal - r.memoryFree) / r.memoryTotal : 0;
  const load = Array.isArray(r.loadAverage) && r.cpus ? r.loadAverage[0] / r.cpus : 0;
  return [
    { id: 'working', label: 'Agents working', value: String((s.agentsWorking || 0) + (s.agentsElsewhere || 0)), detail: s.agentsElsewhere ? s.agentsElsewhere + ' in other OASIS windows' : (s.runsActive ? s.runsActive + ' active run' + (s.runsActive === 1 ? '' : 's') : 'Nothing running'), tone: (s.agentsWorking || s.agentsElsewhere || s.runsActive) ? 'running' : 'idle' },
    { id: 'waiting', label: 'Waiting for you', value: String(s.waitingForYou || 0), detail: s.waitingForYou ? 'Approvals to answer' : 'No open approvals', tone: s.waitingForYou ? 'waiting' : 'idle' },
    { id: 'environments', label: 'Screens and browsers', value: String(s.environments || 0), detail: 'Open in this server', tone: s.environments ? 'running' : 'idle' },
    { id: 'spend', label: 'Tokens, last ' + (s.hours || 24) + 'h', value: formatTokens(s.tokens), detail: s.costUsd ? formatCost(s.costUsd) + ' estimated' : 'No priced usage', tone: 'idle' },
    { id: 'machine', label: 'This computer', value: Math.round(load * 100) + '% load', detail: formatBytes(r.memoryTotal - r.memoryFree) + ' of ' + formatBytes(r.memoryTotal) + ' memory', tone: load > 0.9 || used > 0.9 ? 'waiting' : 'idle' }
  ];
}

/**
 * Agents: live ones from this server first (they can be stopped here), then
 * the ledger's agents from other processes and earlier sessions.
 */
export function controlRoomAgents(snapshot, { now = Date.now(), limit = 60 } = {}) {
  const rows = [];
  const live = snapshot && snapshot.live && snapshot.live.agents || [];
  const seen = new Set();
  for (const agent of live) {
    seen.add(agent.sessionId + '\u0000' + agent.id);
    const status = agent.waitingForApproval ? 'waiting' : agent.status;
    const meta = [agent.role, agent.elapsed, agent.toolCalls ? agent.toolCalls + ' tool calls' : '', agent.tokens ? formatTokens(agent.tokens) + ' tokens' : '', agent.model || '',
      agent.environment ? (agent.environment.kind === 'desktop' ? 'own desktop ' + (agent.environment.screen || '') : 'shared screen') : '',
      agent.isolation === 'worktree' ? 'worktree' : '', agent.access === 'read-only' ? 'read-only' : ''].filter(Boolean);
    rows.push({
      key: 'live:' + agent.sessionId + ':' + agent.id, sessionId: agent.sessionId, agentId: agent.id,
      title: agent.description || agent.role || agent.id, meta: meta.join(' · '),
      status: agent.waitingForApproval ? 'Waiting for approval' : AGENT_STATUS_TEXT[agent.status] || agent.status,
      tone: tone(status), where: agent.sessionTitle || 'This server', depth: agent.depth || 1,
      recent: agent.status === 'running' && agent.recentTools ? agent.recentTools.join(', ') : '',
      stoppable: agent.status === 'running', live: true
    });
  }
  const ledger = snapshot && snapshot.ledger && snapshot.ledger.agents || [];
  for (const agent of ledger) {
    if (seen.has(agent.sessionId + '\u0000' + agent.id)) continue;
    const when = agent.status === 'running' ? 'started ' + ago(agent.startedAt, now) : agent.status === 'quiet' ? 'last activity ' + ago(agent.lastActivity, now) : ago(agent.finishedAt || agent.lastActivity, now);
    rows.push({
      key: 'ledger:' + agent.sessionId + ':' + agent.id, sessionId: agent.sessionId, agentId: agent.id,
      title: agent.description || agent.role || agent.id,
      meta: [agent.role, when, agent.tokens ? formatTokens(agent.tokens) + ' tokens' : '', agent.costUsd ? formatCost(agent.costUsd) : ''].filter(Boolean).join(' · '),
      status: AGENT_STATUS_TEXT[agent.status] || agent.status, tone: tone(agent.status),
      where: 'Session ' + String(agent.sessionId).slice(0, 8), depth: agent.depth || 1, recent: '', stoppable: false, live: false
    });
  }
  return rows.slice(0, limit);
}

export function controlRoomEnvironments(snapshot) {
  const list = snapshot && snapshot.live && snapshot.live.environments || [];
  return list.map((item) => ({
    key: item.sessionId + ':' + item.agentId,
    title: item.agentId === 'main' ? (item.sessionTitle || 'Main agent') : (item.agentDescription || item.agentId),
    kind: item.kind,
    detail: [item.screen ? 'screen ' + item.screen.display + (item.screen.size ? ' (' + item.screen.size + ')' : '') : '', item.screen && item.screen.watch ? 'watch: ' + item.screen.watch : '', item.browserTabs ? item.browserTabs + ' browser tab' + (item.browserTabs === 1 ? '' : 's') : '', item.idle ? 'idle, closes soon' : ''].filter(Boolean).join(' · '),
    tone: item.running ? 'running' : 'idle'
  }));
}

const EVENT_TEXT = { started: 'started', running: 'resumed', completed: 'finished', failed: 'failed', cancelled: 'was stopped', interrupted: 'was interrupted', stalled: 'stalled' };

export function controlRoomHistory(snapshot, { now = Date.now(), limit = 40 } = {}) {
  const list = snapshot && snapshot.ledger && snapshot.ledger.history || [];
  return list.slice(0, limit).map((item, index) => ({
    key: item.sessionId + ':' + item.agentId + ':' + item.at + ':' + index,
    when: ago(item.at, now),
    text: (item.description || item.agentId) + ' ' + (EVENT_TEXT[item.event] || item.event || ''),
    tone: tone(item.event === 'started' ? 'running' : item.event)
  }));
}

export function controlRoomSessions(snapshot, { now = Date.now(), limit = 12 } = {}) {
  const list = snapshot && snapshot.ledger && snapshot.ledger.sessions || [];
  return list.slice(0, limit).map((item) => ({
    key: item.id,
    title: (item.live ? 'Open here · ' : '') + String(item.id).slice(0, 24),
    detail: [item.agents + (item.agents === 1 ? ' agent' : ' agents'), item.running ? item.running + ' working' : '', formatTokens(item.tokens) + ' tokens', item.costUsd ? formatCost(item.costUsd) : '', ago(item.lastActivity, now)].filter(Boolean).join(' · ')
  }));
}

/** Track record rows: success of each agent type and model, from the experience store. */
export function controlRoomTrackRecord(snapshot, { now = Date.now(), limit = 10 } = {}) {
  const list = snapshot && snapshot.experience && snapshot.experience.records || [];
  return list.slice(0, limit).map((item) => ({
    key: item.agentType + '|' + item.model,
    title: item.agentType + (item.model ? ' · ' + item.model : ''),
    tone: item.successRate >= 0.8 ? 'completed' : item.successRate >= 0.5 ? 'waiting' : 'failed',
    detail: [item.runs + (item.runs === 1 ? ' run' : ' runs'), Math.round(item.successRate * 100) + '% succeeded', item.verified ? item.verified + ' verified' : '', item.failed ? item.failed + ' failed' : '', item.rejected ? item.rejected + ' rejected' : '', formatTokens(item.avgTokens) + ' tokens avg', item.avgCostUsd ? formatCost(item.avgCostUsd) + ' avg' : '', ago(item.lastAt, now)].filter(Boolean).join(' · ')
  }));
}
