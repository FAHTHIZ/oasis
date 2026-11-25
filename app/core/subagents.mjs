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

export class SubagentTracker {
  constructor() { this.workers = new Map(); }
  // Returns true when the list changed.
  update(data = {}) {
    const id = String(data.agent_id || '').slice(0, 100);
    if (!id) return false;
    const type = String(data.type || '');
    const current = this.workers.get(id) || { id, description: id, status: 'unknown', detail: '', teamId: '', budget: '', waitingApproval: false, order: this.workers.size };
    if (data.description && type !== 'task.dispatched') current.description = String(data.description).slice(0, 200);
    if (data.team_id) current.teamId = String(data.team_id).slice(0, 100);
    if (STATE_FOR[type]) current.status = STATE_FOR[type];
    if (current.status !== 'running' && current.status !== 'unknown') current.activity = '';
    // A parked approval (roadmap 2.1) stays flagged until the user answers it.
    if (type === 'agent.approval_pending') current.waitingApproval = true;
    if (type === 'agent.approval_granted' || type === 'agent.approval_denied') current.waitingApproval = false;
    if (data.budget) current.budget = String(data.budget).slice(0, 200);
    const detail = String(data.detail || '').replace(/\s+/g, ' ').trim();
    // Skip runtime counters such as "tool_calls=0 duration_ms=812".
    if (detail && !type.startsWith('agent.approval_') && !/^(?:[a-z_]+=\S+\s*)+$/i.test(detail)) current.detail = detail.slice(0, 240);
    this.workers.set(id, current);
    return true;
  }
  // A step the subagent just started ("Reading cart.js", "Running npm test").
  // tool_start events name the subagent by description, not id, so the newest
  // running worker with that description is the one at work. Without this the
  // row said only "Working" for minutes while the child read, ran and edited.
  step(description, text, { finished = false } = {}) {
    const name = String(description || '').slice(0, 200);
    const label = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!name) return false;
    const matches = [...this.workers.values()].filter((w) => w.description === name);
    const worker = matches.filter((w) => w.status === 'running' || w.status === 'unknown').pop() || matches.pop();
    if (!worker) return false;
    if (finished) { worker.steps = (worker.steps || 0) + 1; return true; }
    if (!label) return false;
    worker.activity = label;
    return true;
  }
  list() { return [...this.workers.values()].sort((a, b) => a.order - b.order).map(({ order, ...worker }) => worker); }
  get running() { return this.list().filter((worker) => worker.status === 'running' || worker.status === 'stopping').length; }
}
