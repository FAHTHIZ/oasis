// Oasis Neuron Network: lineage and read-only graph projection for the existing agent registry.
// The registry remains the source of truth; this module does not create a second worker runtime.

const MAX_NEURON_DEPTH = 32;
// Every status an agent record can hold (agent-subagents sets "stalled" when a
// worker stops making progress); anything else is shown as interrupted.
const VALID_STATUSES = new Set(["running", "completed", "failed", "cancelled", "stalled", "interrupted"]);

function clean(value, max = 160) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function safeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

/**
 * Attach an agent to an already-registered parent. Missing or stale parents
 * safely collapse to the coordinator root during session restoration.
 */
export function attachNeuronLineage(registry, record, requestedParentId = "main") {
  const candidate = clean(requestedParentId, 100);
  const parentId = candidate !== "main" && registry?.agents?.has(candidate) ? candidate : "main";
  const parent = parentId === "main" ? null : registry.agents.get(parentId);
  const depth = parent ? Math.max(1, Math.floor(safeNumber(parent.depth, 1))) + 1 : 1;
  if (depth > MAX_NEURON_DEPTH) {
    throw new Error("Oasis Neuron Network depth limit reached (" + MAX_NEURON_DEPTH + ").");
  }
  record.parentId = parentId;
  record.depth = depth;
  return record;
}

/** Every agent below `id` in the lineage, nearest first. Cycles and stale links are ignored. */
export function descendantRecords(registry, id) {
  const agents = registry && registry.agents ? [...registry.agents.values()] : [];
  const out = [];
  const seen = new Set([id]);
  let frontier = [id];
  for (let depth = 0; depth < MAX_NEURON_DEPTH && frontier.length; depth++) {
    const next = [];
    for (const record of agents) {
      if (seen.has(record.id) || !frontier.includes(record.parentId)) continue;
      seen.add(record.id);
      out.push(record);
      next.push(record.id);
    }
    frontier = next;
  }
  return out;
}

const BUDGET_KINDS = ["tokens", "usd", "requests", "steps", "children"];

// Budget view of one neuron (roadmap 2.6): its limits, what it spent and,
// while it runs, what is left. Kinds with neither a limit nor any spend are
// left out; an agent without a budget and without spend gets no field.
export function projectBudget(record) {
  const live = record?.child?.budgetNode;
  const limits = record?.budgetLimits && typeof record.budgetLimits === "object" ? record.budgetLimits : {};
  const spent = { ...(record?.budgetSpent || {}) };
  if (live && live.spent) for (const [kind, value] of Object.entries(live.spent)) spent[kind] = safeNumber(spent[kind]) + safeNumber(value);
  const out = {};
  for (const kind of BUDGET_KINDS) {
    const limit = Number(limits[kind]);
    const used = safeNumber(spent[kind]);
    const hasLimit = Number.isFinite(limit) && limit > 0;
    if (!hasLimit && !used) continue;
    const round = (value) => (kind === "usd" ? Number(value.toFixed(6)) : Math.floor(value));
    out[kind] = { spent: round(used), ...(hasLimit ? { limit: round(limit), left: round(Math.max(0, limit - used)) } : {}) };
  }
  return Object.keys(out).length ? out : null;
}

/** One line for /tasks: "budget tokens 1,200/50,000 left 48,800, usd $0.01/$0.50". */
export function formatBudget(budget) {
  if (!budget) return "";
  const show = (kind, value) => (kind === "usd" ? "$" + Number(value).toFixed(2) : Number(value).toLocaleString("en-US"));
  const parts = Object.entries(budget).map(([kind, item]) => kind + " " + show(kind, item.spent) + (item.limit !== undefined ? "/" + show(kind, item.limit) : ""));
  return parts.length ? "budget " + parts.join(", ") : "";
}

function projectNode(record, children, contextOnly = false) {
  const id = clean(record.id, 100);
  const status = VALID_STATUSES.has(record.status) ? record.status : "interrupted";
  const usage = record.usage && typeof record.usage === "object" ? record.usage : null;
  const model = clean(record.child?.config?.model || record.model, 120);
  const budget = projectBudget(record);
  return {
    id,
    parent_id: clean(record.parentId || "main", 100),
    depth: Math.max(1, Math.min(MAX_NEURON_DEPTH, Math.floor(safeNumber(record.depth, 1)))),
    role: clean(record.type || "general-purpose", 80),
    description: clean(record.description || record.type || id, 160),
    status,
    background: Boolean(record.background),
    team_id: clean(record.teamId, 100) || null,
    task_id: clean(record.sharedTaskId, 100) || null,
    workspace: record.worktreeInfo || record.worktree || record.workspaceIsolation === "worktree" ? "worktree" : "shared",
    access: record.readOnly ? "read-only" : "write-capable",
    ...(model ? { model } : {}),
    child_count: children.get(id) || 0,
    tool_calls: Math.floor(safeNumber(record.toolCalls)),
    tokens_used: Math.floor(safeNumber(usage?.totalTokens, safeNumber(record.tokensUsed))),
    estimated_cost_usd: Number(safeNumber(usage?.costUsd).toFixed(6)),
    elapsed_seconds: Math.floor(Math.max(0, (safeNumber(record.finishedAt) || Date.now()) - safeNumber(record.startedAt)) / 1000),
    ...(budget ? { budget } : {}),
    ...(contextOnly ? { context_only: true } : {})
  };
}

/**
 * Produce a bounded, read-only network projection. Prompts, transcripts,
 * reports, tool arguments and credentials are deliberately never exposed.
 *
 * Filtered views retain the ancestors needed to keep the returned graph
 * connected. Ancestors added only for graph context are marked context_only
 * and do not count toward visible_agents or the requested result limit.
 */
export function buildNeuronNetworkSnapshot(registry, args = {}) {
  const records = registry?.agents instanceof Map ? [...registry.agents.values()] : [];
  const requestedStatus = clean(args.status, 24);
  if (requestedStatus && !VALID_STATUSES.has(requestedStatus)) {
    throw new Error("status must be running, completed, failed, cancelled, stalled, or interrupted.");
  }
  const teamId = clean(args.team_id, 100);
  const parentId = clean(args.parent_id, 100);
  const includeInactive = args.include_inactive !== false;
  const limit = Math.max(1, Math.min(100, Math.floor(Number(args.limit) || 50)));

  const ordered = records
    .filter((record) => record && typeof record === "object")
    .sort((a, b) => {
      const depthDifference = Math.floor(safeNumber(a.depth, 1)) - Math.floor(safeNumber(b.depth, 1));
      return depthDifference || safeNumber(a.startedAt) - safeNumber(b.startedAt);
    });
  const byId = new Map(ordered.map((record) => [clean(record.id, 100), record]).filter(([id]) => id));
  const matches = ordered.filter((record) => {
    const status = VALID_STATUSES.has(record.status) ? record.status : "interrupted";
    return (!requestedStatus || status === requestedStatus)
      && (!teamId || record.teamId === teamId)
      && (!parentId || (record.parentId || "main") === parentId)
      && (includeInactive || status === "running");
  });
  const truncated = matches.length > limit;
  const visible = matches.slice(0, limit);
  const included = new Map(visible.map((record) => [clean(record.id, 100), { record, contextOnly: false }]));

  // Include every available ancestor so no emitted edge points at a missing node.
  // The visited set also makes a malformed restored lineage cycle harmless.
  for (const record of visible) {
    let cursor = clean(record.parentId || "main", 100);
    const visited = new Set([clean(record.id, 100)]);
    while (cursor && cursor !== "main" && !visited.has(cursor)) {
      visited.add(cursor);
      const ancestor = byId.get(cursor);
      if (!ancestor) break;
      if (!included.has(cursor)) included.set(cursor, { record: ancestor, contextOnly: true });
      cursor = clean(ancestor.parentId || "main", 100);
    }
  }

  const children = new Map();
  for (const record of ordered) {
    const id = clean(record.parentId || "main", 100);
    children.set(id, (children.get(id) || 0) + 1);
  }

  const nodes = [{
    id: "main",
    parent_id: null,
    depth: 0,
    role: "coordinator",
    description: "Oasis main coordinator",
    status: "running",
    child_count: children.get("main") || 0
  }];
  const edges = [];
  const includedIds = new Set(included.keys());
  const projected = [...included.values()].sort((a, b) => {
    const depthDifference = Math.floor(safeNumber(a.record.depth, 1)) - Math.floor(safeNumber(b.record.depth, 1));
    if (depthDifference) return depthDifference;
    const startedDifference = safeNumber(a.record.startedAt) - safeNumber(b.record.startedAt);
    return startedDifference || clean(a.record.id, 100).localeCompare(clean(b.record.id, 100));
  });
  for (const item of projected) {
    const record = item.record;
    const id = clean(record.id, 100);
    const requestedParent = clean(record.parentId || "main", 100);
    const parent = includedIds.has(requestedParent) ? requestedParent : "main";
    nodes.push(projectNode({ ...record, parentId: parent }, children, item.contextOnly));
    edges.push({ from: parent, to: id, relation: "spawned" });
  }

  const counts = Object.fromEntries([...VALID_STATUSES].map((status) => [status, ordered.filter((record) => record.status === status).length]));
  const totalTokens = ordered.reduce((sum, record) => {
    const usage = record.usage && typeof record.usage === "object" ? record.usage : null;
    return sum + safeNumber(usage?.totalTokens, safeNumber(record.tokensUsed));
  }, 0);
  const totalCost = ordered.reduce((sum, record) => sum + safeNumber(record.usage?.costUsd), 0);
  const unknownCostAgents = ordered.filter((record) => !record.usage || record.usage.costKnown === false).length;
  return {
    network: "Oasis Neuron Network",
    schema_version: 1,
    root_id: "main",
    nodes,
    edges,
    summary: {
      total_agents: ordered.length,
      visible_agents: visible.length,
      context_agents: projected.length - visible.length,
      running_agents: counts.running,
      completed_agents: counts.completed,
      failed_agents: counts.failed,
      cancelled_agents: counts.cancelled,
      stalled_agents: counts.stalled,
      interrupted_agents: counts.interrupted,
      max_depth: ordered.reduce((max, record) => Math.max(max, Math.min(MAX_NEURON_DEPTH, Math.floor(safeNumber(record.depth, 1)))), 0),
      total_tool_calls: ordered.reduce((sum, record) => sum + Math.floor(safeNumber(record.toolCalls)), 0),
      total_tokens: Math.floor(totalTokens),
      estimated_cost_usd: Number(totalCost.toFixed(6)),
      cost_unknown_agents: unknownCostAgents
    },
    truncated
  };
}
