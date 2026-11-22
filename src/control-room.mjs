// Control room: one view of every agent on this computer.
//
// Two sources are combined:
//   - The neuron ledger (src/neuron-ledger.mjs), which every OASIS process on
//     this computer writes: the terminal, the web app, chat gateways, A2A and
//     cloud pulls. It knows each agent's lineage, status, tokens and cost, even
//     for processes that have exited, but not what is open right now.
//   - Live sessions in this process (the web server's), which know each running
//     agent's tools, approvals and its own screen and browser.
//
// Everything here is lifecycle facts and short task descriptions, never
// prompts, model output or tool results.

import { sharedExperienceStore, trackRecord } from './agent-experience.mjs';
import os from 'node:os';
import { reduceNeuronLedger, sharedNeuronLedger } from './neuron-ledger.mjs';
import { listAgents } from './agent-tasks.mjs';

export const CONTROL_ROOM_WINDOW_HOURS = 24;
// A ledger agent still marked running with no row for this long probably
// belongs to a process that was killed (the ledger has no heartbeat).
const QUIET_MS = 30 * 60_000;
const MAX_NEURONS = 80;
const MAX_HISTORY = 60;

const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'stalled', 'interrupted']);

function round(value, digits = 6) {
  const number = Number(value);
  return Number.isFinite(number) ? Number(number.toFixed(digits)) : 0;
}

function clip(value, max) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

/**
 * Ledger activity of the last `hours`, across sessions and processes. Pure over
 * `recent` (the ledger's recent() output) so it can be tested without SQLite.
 */
export function summarizeLedger(recent, { now = Date.now(), since = 0, liveSessionIds = new Set() } = {}) {
  const totals = { agents: 0, running: 0, quiet: 0, completed: 0, failed: 0, cancelled: 0, interrupted: 0, stalled: 0, tokens: 0, costUsd: 0, requests: 0 };
  const sessions = [];
  const neurons = [];
  const history = [];
  for (const { sessionId, rows } of recent || []) {
    const reduced = reduceNeuronLedger(rows);
    const descriptions = new Map([...reduced.values()].map((neuron) => [neuron.id, neuron.description || neuron.role]));
    const summary = { id: clip(sessionId, 200), agents: 0, running: 0, tokens: 0, costUsd: 0, requests: 0, lastActivity: 0, live: liveSessionIds.has(sessionId) };
    for (const neuron of reduced.values()) {
      // Charges inside the window count, so a long session is not billed for last week.
      let tokens = 0; let cost = 0; let requests = 0;
      for (const row of rows) {
        if (row.neuron_id !== neuron.id || row.kind !== 'charge' || Number(row.at) < since) continue;
        tokens += Number(row.tokens) || 0; cost += Number(row.cost_usd) || 0; requests += Number(row.requests) || 0;
      }
      const active = neuron.status === 'running';
      if (!active && (neuron.finishedAt || neuron.lastAt || 0) < since && !tokens) continue;
      const quiet = active && !summary.live && now - (neuron.lastAt || neuron.startedAt) > QUIET_MS;
      summary.agents += 1; totals.agents += 1;
      if (active && !quiet) { summary.running += 1; totals.running += 1; }
      if (quiet) totals.quiet += 1;
      if (TERMINAL.has(neuron.status)) totals[neuron.status] += 1;
      summary.tokens += tokens; summary.costUsd += cost; summary.requests += requests;
      totals.tokens += tokens; totals.costUsd += cost; totals.requests += requests;
      summary.lastActivity = Math.max(summary.lastActivity, neuron.lastAt || 0);
      neurons.push({
        sessionId: summary.id, id: neuron.id, parentId: neuron.parentId, depth: neuron.depth,
        role: clip(neuron.role, 80), description: clip(neuron.description, 200), teamId: neuron.teamId,
        status: quiet ? 'quiet' : neuron.status, startedAt: neuron.startedAt || null, finishedAt: neuron.finishedAt || null,
        lastActivity: neuron.lastAt || null, tokens, costUsd: round(cost), requests
      });
    }
    for (const row of rows) {
      if (Number(row.at) < since || row.kind === 'charge') continue;
      history.push({ at: Number(row.at) || 0, sessionId: summary.id, agentId: row.neuron_id, description: clip(descriptions.get(row.neuron_id) || '', 120), event: row.kind === 'spawn' ? 'started' : row.status });
    }
    if (summary.agents) sessions.push({ ...summary, costUsd: round(summary.costUsd) });
  }
  const order = { running: 0, quiet: 1 };
  neurons.sort((a, b) => (order[a.status] ?? 2) - (order[b.status] ?? 2) || (b.lastActivity || 0) - (a.lastActivity || 0));
  history.sort((a, b) => b.at - a.at);
  sessions.sort((a, b) => b.lastActivity - a.lastActivity);
  return { totals: { ...totals, costUsd: round(totals.costUsd) }, sessions, agents: neurons.slice(0, MAX_NEURONS), history: history.slice(0, MAX_HISTORY) };
}

/** Read the shared ledger. `available: false` when it is off or node:sqlite is missing. */
export function ledgerActivity({ env = process.env, hours = CONTROL_ROOM_WINDOW_HOURS, now = Date.now(), liveSessionIds } = {}) {
  const ledger = sharedNeuronLedger(env);
  const windowHours = Math.max(1, Math.min(24 * 30, Number(hours) || CONTROL_ROOM_WINDOW_HOURS));
  const since = now - windowHours * 3600_000;
  if (!ledger) return { available: false, hours: windowHours, since, ...summarizeLedger([], { now, since }) };
  let recent = [];
  try { recent = ledger.recent(since, 60); } catch { return { available: false, hours: windowHours, since, ...summarizeLedger([], { now, since }) }; }
  return { available: true, hours: windowHours, since, ...summarizeLedger(recent, { now, since, liveSessionIds }) };
}

function screenOf(state) {
  const virtual = state && state.virtual;
  if (!virtual || !virtual.display) return null;
  return { display: clip(virtual.display, 40), ...(virtual.size && virtual.size.width ? { size: virtual.size.width + 'x' + virtual.size.height } : {}), ...(virtual.vnc && virtual.vnc.address ? { watch: 'VNC ' + clip(virtual.vnc.address, 80) } : {}) };
}

function browserTabs(session) {
  const state = session && session.browserState;
  return state && Array.isArray(state.tabs) ? state.tabs.length : 0;
}

/**
 * Agents and environments in this process's live sessions.
 * `sessions` is [{ id, title, session, running }].
 */
export function liveActivity(sessions = []) {
  const agents = [];
  const environments = [];
  for (const { id, title, session, running } of sessions) {
    if (!session) continue;
    const owner = { sessionId: clip(id, 200), sessionTitle: clip(title || '', 160) };
    const screen = screenOf(session.computerState);
    const tabs = browserTabs(session);
    if (screen || tabs) environments.push({ ...owner, agentId: 'main', kind: screen ? 'virtual screen' : 'browser', ...(screen ? { screen } : {}), ...(tabs ? { browserTabs: tabs } : {}), running: Boolean(running) });
    let list = [];
    try { list = listAgents(session); } catch { list = []; }
    const records = session.agentTasks && session.agentTasks.agents instanceof Map ? session.agentTasks.agents : new Map();
    for (const agent of list) {
      agents.push({
        ...owner, id: agent.id, parentId: agent.parent_id, depth: agent.depth, role: clip(agent.agent, 80), description: clip(agent.description, 200),
        status: agent.status, background: agent.background, elapsed: agent.elapsed, toolCalls: agent.toolCalls || 0,
        ...(agent.model ? { model: agent.model } : {}), ...(agent.usage ? { tokens: agent.usage.totalTokens || 0, costUsd: agent.usage.costUsd || 0 } : {}),
        ...(agent.recentTools ? { recentTools: agent.recentTools.map((tool) => clip(typeof tool === 'string' ? tool : tool && tool.name, 60)) } : {}),
        ...(agent.waitingForApproval ? { waitingForApproval: agent.waitingForApproval.length } : {}),
        ...(agent.environment ? { environment: agent.environment } : {}),
        isolation: agent.workspaceIsolation, access: agent.access
      });
      const child = records.get(agent.id) && records.get(agent.id).child;
      const childScreen = child && screenOf(child.computerState);
      const childTabs = child ? browserTabs(child) : 0;
      if (childScreen || childTabs || (agent.environment && agent.environment.kind === 'desktop')) {
        environments.push({ ...owner, agentId: agent.id, agentDescription: clip(agent.description, 120), kind: agent.environment && agent.environment.kind === 'desktop' ? 'own desktop' : childScreen ? 'virtual screen' : 'browser', ...(childScreen ? { screen: childScreen } : {}), ...(childTabs ? { browserTabs: childTabs } : {}), ...(agent.environment && agent.environment.idle ? { idle: true } : {}), running: agent.status === 'running' });
      }
    }
  }
  return { agents, environments };
}

/** This computer's load, memory and this process's footprint. */
export function systemResources() {
  const memory = process.memoryUsage();
  const cpus = os.cpus() || [];
  return {
    platform: process.platform, arch: process.arch,
    cpus: cpus.length, cpuModel: clip(cpus[0] && cpus[0].model || '', 80),
    loadAverage: os.loadavg().map((value) => round(value, 2)),
    memoryTotal: os.totalmem(), memoryFree: os.freemem(),
    processRss: memory.rss, processHeapUsed: memory.heapUsed,
    uptimeSeconds: Math.round(process.uptime())
  };
}

/**
 * Track record of each agent type and model over the last 30 days, from the
 * agent experience store (src/agent-experience.mjs): every project, outcomes
 * decided from evidence. Never prompts or reports, only counts.
 */
export function experienceActivity({ env = process.env, now = Date.now(), days = 30, limit = 12 } = {}) {
  const store = sharedExperienceStore(env);
  if (!store) return { available: false, days, records: [] };
  let rows = [];
  try { rows = store.runs({ since: now - days * 86400000, limit: 5000 }); } catch { return { available: false, days, records: [] }; }
  const records = trackRecord(rows, { by: ['agentType', 'model'] }).slice(0, limit).map((item) => ({
    agentType: item.agentType, model: item.model, runs: item.runs, succeeded: item.succeeded, verified: item.verified,
    failed: item.failed, rejected: item.rejected, successRate: item.successRate, avgTokens: item.avgTokens,
    avgCostUsd: item.avgCostUsd, avgDurationMs: item.avgDurationMs, lastAt: item.lastAt
  }));
  return { available: true, days, runs: rows.length, records };
}

/** The whole control room snapshot served at /api/control-room. */
export function controlRoomSnapshot({ sessions = [], runs = [], env = process.env, hours, now = Date.now() } = {}) {
  const live = liveActivity(sessions);
  const liveIds = new Set(sessions.map((item) => item.id));
  const ledger = ledgerActivity({ env, hours, now, liveSessionIds: liveIds });
  const waiting = live.agents.reduce((sum, agent) => sum + (agent.waitingForApproval || 0), 0)
    + runs.reduce((sum, run) => sum + (run && run.approvals && run.approvals.pending || 0), 0);
  const working = live.agents.filter((agent) => agent.status === 'running').length;
  return {
    updatedAt: new Date(now).toISOString(),
    summary: {
      runsActive: runs.filter((run) => run && ['queued', 'running', 'waiting_approval'].includes(run.status)).length,
      agentsWorking: working,
      // Running agents of other processes (the terminal, gateways) seen in the ledger.
      agentsElsewhere: ledger.agents.filter((agent) => agent.status === 'running' && !liveIds.has(agent.sessionId)).length,
      waitingForYou: waiting,
      environments: live.environments.length,
      tokens: ledger.totals.tokens,
      costUsd: ledger.totals.costUsd,
      hours: ledger.hours
    },
    runs,
    live,
    ledger,
    experience: experienceActivity({ env, now }),
    resources: systemResources()
  };
}

function ago(ms, now) {
  if (!ms) return '';
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 60) return seconds + 's ago';
  if (seconds < 3600) return Math.round(seconds / 60) + 'm ago';
  if (seconds < 86400) return Math.round(seconds / 3600) + 'h ago';
  return Math.round(seconds / 86400) + 'd ago';
}

/** Plain-text control room for `oasis control-room` (the ledger and this computer). */
export function formatControlRoom(snapshot, { now = Date.now() } = {}) {
  const { ledger, resources } = snapshot;
  const lines = [];
  const gb = (bytes) => (bytes / 1024 ** 3).toFixed(1) + ' GB';
  lines.push('OASIS control room (last ' + ledger.hours + 'h, every OASIS process on this computer)');
  if (!ledger.available) lines.push('  The agent ledger is off or unavailable here (OASIS_NEURON_LEDGER=0, or no node:sqlite), so only this computer is shown.');
  const t = ledger.totals;
  lines.push('  Agents: ' + t.agents + ' (' + t.running + ' running' + (t.quiet ? ', ' + t.quiet + ' quiet for 30m+' : '') + ', ' + t.completed + ' done, ' + t.failed + ' failed, ' + (t.cancelled + t.interrupted + t.stalled) + ' stopped)');
  lines.push('  Spend:  ' + t.tokens.toLocaleString('en-US') + ' tokens, ' + t.requests + ' model requests' + (t.costUsd ? ', $' + t.costUsd.toFixed(4) : ''));
  lines.push('  This computer: load ' + resources.loadAverage.join(' ') + ' on ' + resources.cpus + ' CPUs, ' + gb(resources.memoryTotal - resources.memoryFree) + ' of ' + gb(resources.memoryTotal) + ' memory in use');
  const active = ledger.agents.filter((agent) => agent.status === 'running' || agent.status === 'quiet');
  if (active.length) {
    lines.push('', 'Working now:');
    for (const agent of active.slice(0, 20)) lines.push('  ' + agent.id + '  ' + agent.role + '  ' + (agent.description || '') + '  [' + (agent.status === 'quiet' ? 'no activity ' + ago(agent.lastActivity, now) : 'started ' + ago(agent.startedAt, now)) + ', session ' + agent.sessionId.slice(0, 8) + ']');
  }
  if (ledger.sessions.length) {
    lines.push('', 'Sessions:');
    for (const session of ledger.sessions.slice(0, 15)) lines.push('  ' + session.id.slice(0, 24).padEnd(24) + '  ' + String(session.agents).padStart(3) + ' agents  ' + String(session.tokens.toLocaleString('en-US')).padStart(10) + ' tokens' + (session.costUsd ? '  $' + session.costUsd.toFixed(4) : '') + '  ' + ago(session.lastActivity, now));
  }
  if (ledger.history.length) {
    lines.push('', 'Recent:');
    for (const item of ledger.history.slice(0, 15)) lines.push('  ' + ago(item.at, now).padEnd(8) + ' ' + item.agentId + ' ' + item.event + (item.description ? ': ' + item.description : ''));
  }
  const experience = snapshot.experience;
  if (experience && experience.records && experience.records.length) {
    lines.push('', 'Track record (last ' + experience.days + ' days, outcomes from evidence):');
    for (const item of experience.records.slice(0, 10)) lines.push('  ' + (item.agentType + ' / ' + (item.model || '?')).slice(0, 48).padEnd(48) + '  ' + String(item.runs).padStart(4) + ' runs  ' + String(Math.round(item.successRate * 100)).padStart(3) + '% ok  ' + item.verified + ' verified  ' + item.failed + ' failed  ' + item.rejected + ' rejected');
  }
  if (!ledger.agents.length) lines.push('', 'No agents in this window. Subagents, background agents and teams show up here as they run.');
  return lines.join('\n') + '\n';
}
