// Live subagent list for the web app, built from the runtime's
// `agent_activity` events (the same lifecycle the terminal's /tasks shows).
const STATE_FOR = {
  'agent.started': 'running', 'agent.background_started': 'running', 'agent.resumed': 'running', 'task.dispatched': 'running',
  'agent.stop_requested': 'stopping', 'agent.completed': 'completed', 'agent.failed': 'failed',
  'agent.cancelled': 'cancelled', 'agent.interrupted': 'interrupted'
};

export const SUBAGENT_STATUS_TEXT = {
  running: 'Working', stopping: 'Stopping', completed: 'Done', failed: 'Failed',
  cancelled: 'Stopped', interrupted: 'Interrupted', unknown: 'Waiting'
};

const MAX_LOG = 80;

export class SubagentTracker {
  constructor() { this.workers = new Map(); }
  // Returns true when the list changed.
  update(data = {}, { at = Date.now() } = {}) {
    const id = String(data.agent_id || '').slice(0, 100);
    if (!id) return false;
    const type = String(data.type || '');
    const current = this.workers.get(id) || { id, description: id, status: 'unknown', detail: '', teamId: '', budget: '', waitingApproval: false, order: this.workers.size };
    if (data.description && type !== 'task.dispatched') current.description = String(data.description).slice(0, 200);
    if (data.team_id) current.teamId = String(data.team_id).slice(0, 100);
    if (STATE_FOR[type]) current.status = STATE_FOR[type];
    // When it started and finished, for the Activity panel's agent lanes.
    if (current.status === 'running' && !current.startedAt) current.startedAt = at;
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(current.status)) { current.endedAt = at; if (!current.startedAt) current.startedAt = at; for (const item of current.log || []) if (!item.endedAt) item.endedAt = at; }
    else if (current.status === 'running') delete current.endedAt;
    if (current.status !== 'running' && current.status !== 'unknown') current.activity = '';
    // A parked approval (roadmap 2.1) stays flagged until the user answers it.
    if (type === 'agent.approval_pending') current.waitingApproval = true;
    if (type === 'agent.approval_granted' || type === 'agent.approval_denied') current.waitingApproval = false;
    if (data.budget) current.budget = String(data.budget).slice(0, 200);
    const detail = plainReport(String(data.report || data.detail || '')).replace(/\s+/g, ' ').trim();
    // Skip runtime counters such as "tool_calls=0 duration_ms=812".
    if (detail && !type.startsWith('agent.approval_') && !/^(?:[a-z_]+=\S+\s*)+$/i.test(detail)) current.detail = detail.slice(0, 240);
    this.workers.set(id, current);
    return true;
  }
  // A step the subagent just started ("Reading cart.js", "Running npm test").
  // tool_start events name the subagent by description, not id, so the newest
  // running worker with that description is the one at work. Without this the
  // row said only "Working" for minutes while the child read, ran and edited.
  step(description, text, { finished = false, at = Date.now(), name: toolName = '', path = '', ok = true, lines = null, outcome = '', brief = '' } = {}) {
    const name = String(description || '').slice(0, 200);
    const label = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!name) return false;
    const matches = [...this.workers.values()].filter((w) => w.description === name);
    const worker = matches.filter((w) => w.status === 'running' || w.status === 'unknown').pop() || matches.pop();
    if (!worker) return false;
    if (finished) {
      worker.steps = (worker.steps || 0) + 1;
      // Its last step is over: say so instead of showing it as still running.
      if (worker.status === 'running' || worker.status === 'unknown') { worker.activity = 'Thinking about the next step'; worker.activityAt = at; }
      worker.lastBrief = brief ? String(brief).slice(0, 120) : '';
      const open = (worker.log || []).find((item) => !item.endedAt);
      if (open) {
        open.endedAt = at;
        open.ok = ok !== false;
        if (outcome) open.outcome = outcome;
        if (brief) open.brief = String(brief).slice(0, 120);
        if (lines && (Number(lines.added) > 0 || Number(lines.removed) > 0)) open.lines = { added: Math.max(0, Number(lines.added) || 0), removed: Math.max(0, Number(lines.removed) || 0) };
      }
      return true;
    }
    if (!label) return false;
    worker.activity = label;
    worker.activityAt = at;
    delete worker.paused; delete worker.pausedUntil; delete worker.pausedAt;
    // Its own steps, kept short, so the run can be replayed after it ends.
    worker.log = worker.log || [];
    worker.log.push({ label, startedAt: at, ...(toolName ? { name: String(toolName).slice(0, 60) } : {}), ...(path ? { path: String(path).slice(0, 300) } : {}) });
    if (worker.log.length > MAX_LOG) worker.log.splice(0, worker.log.length - MAX_LOG);
    return true;
  }
  // Why a running agent is quiet between steps: queued behind another agent on
  // a one-at-a-time endpoint, or waiting out a provider error. `until` lets a
  // retry note lapse on its own; '' clears the note.
  pause(description, text, { until = 0, at = Date.now() } = {}) {
    const name = String(description || '').slice(0, 200);
    const worker = [...this.workers.values()].filter((w) => w.description === name && (w.status === 'running' || w.status === 'unknown')).pop();
    if (!worker) return false;
    const label = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!label) {
      if (!worker.paused) return false;
      delete worker.paused; delete worker.pausedUntil; delete worker.pausedAt;
      return true;
    }
    // The timer counts from when it started waiting, not from a repeat note.
    if (worker.paused !== label || !worker.pausedAt) worker.pausedAt = at;
    worker.paused = label;
    if (until > 0) worker.pausedUntil = until; else delete worker.pausedUntil;
    return true;
  }
  // A foreground approval this agent asked for is open (or was answered).
  waiting(description, on, { at = Date.now() } = {}) {
    const name = String(description || '').slice(0, 200);
    const worker = [...this.workers.values()].filter((w) => w.description === name && (w.status === 'running' || w.status === 'unknown')).pop();
    if (!worker || worker.waitingApproval === Boolean(on)) return false;
    worker.waitingApproval = Boolean(on);
    if (on) worker.waitingAt = at; else delete worker.waitingAt;
    return true;
  }
  list({ now = Date.now() } = {}) {
    return [...this.workers.values()].sort((a, b) => a.order - b.order).map(({ order, log, paused, pausedUntil, pausedAt, ...worker }) => {
      const live = paused && (worker.status === 'running' || worker.status === 'unknown') && !(pausedUntil && now > pausedUntil);
      return { ...worker, ...(live ? { activity: paused, activityAt: pausedAt } : {}), ...(log ? { log: log.map((item) => ({ ...item })) } : {}) };
    });
  }
  get running() { return this.list().filter((worker) => worker.status === 'running' || worker.status === 'stopping').length; }
}

// "tokens 8,218, requests 2, steps 2" → "8.2k tokens · 2 requests";
// a limit reads "8.2k of 50k tokens". The budget's "steps" are model rounds,
// not the tool steps the Activity lane counts, so an unlimited count is left
// out (requests already says it) and only a limit ("2 of 10 steps") shows.
// Unknown parts pass through unchanged.
export function friendlyBudget(text) {
  const raw = String(text || '').replace(/^budget\s+/i, '').trim();
  if (!raw) return '';
  const short = (value) => {
    const n = Number(String(value).replace(/,/g, ''));
    if (!Number.isFinite(n)) return String(value);
    if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(n);
  };
  const nouns = { tokens: ['token', 'tokens'], requests: ['request', 'requests'], steps: ['step', 'steps'], usd: ['', ''] };
  return raw.split(/,\s+(?=[a-z_]+\s)/i).map((part) => {
    const match = /^([a-z_]+)\s+(\$?[\d.,]+)(?:\/(\$?[\d.,]+))?$/i.exec(part.trim());
    if (!match) return part.trim();
    const [, kind, spent, limit] = match;
    if (kind === 'usd') return limit ? spent + ' of ' + limit : spent;
    if (kind === 'steps' && !limit) return '';
    const [one, many] = nouns[kind] || [kind, kind];
    const value = short(spent);
    return (limit ? value + ' of ' + short(limit) : value) + ' ' + (!limit && value === '1' ? one : many);
  }).filter(Boolean).join(' · ');
}

// Small models sometimes end a subagent with {"summary": "…"} instead of
// prose. Show the text, not the JSON around it (only for one text field).
export function plainReport(text) {
  const raw = String(text || '').trim();
  if (!/^\{[\s\S]*\}$/.test(raw)) return String(text || '');
  let value;
  try { value = JSON.parse(raw); } catch { return String(text || ''); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return String(text || '');
  const keys = Object.keys(value);
  const key = keys.length === 1 && /^(?:summary|report|result|answer|findings|output|text|response|message|content)$/i.test(keys[0]) ? keys[0] : '';
  return key && typeof value[key] === 'string' && value[key].trim() ? value[key].trim() : String(text || '');
}

// Which delegation step each subagent belongs to. A turn's subagent updates
// list every agent so far; each one stays with the step that was current when
// it first appeared, so a second "task" step shows only the agents it started.
// Returns a Map of step -> its workers (in update order), touching only steps
// that own at least one worker.
export function workersByStep(homes, workers = [], step) {
  const byStep = new Map();
  for (const worker of Array.isArray(workers) ? workers : []) {
    if (!worker) continue;
    const key = worker.id || worker.description;
    if (!homes.has(key)) homes.set(key, step);
    const home = homes.get(key);
    if (!byStep.has(home)) byStep.set(home, []);
    byStep.get(home).push(worker);
  }
  return byStep;
}
