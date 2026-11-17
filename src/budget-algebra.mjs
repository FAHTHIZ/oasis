// Budget algebra for the neuron network (roadmap 1.3).
//
// Every neuron owns a budget node. A node has limits for five kinds of spend:
// tokens, usd, requests, steps and children. A missing limit is unlimited.
//
// A parent hands a child part of its budget with reserve(). The reservation
// counts against the parent at once, so siblings cannot spend it too. The
// child's spend draws its reservation down first; spend past the reservation
// would need the child's own limit, which is never larger than the grant, so a
// child cannot overspend it. When the child ends, close() returns what it did
// not spend: the outstanding part of the reservation is released.
//
// The invariant, at every node X and for every kind k:
//   spent(X, k) + sum over open children c of max(0, grant(c, k) - spent(c, k)) <= limit(X, k)
// where spent(X) includes the spend of all of X's descendants. A charge is
// checked against every ancestor before it is applied, so it is all or
// nothing. Charges recorded after the fact (the real token count of a reply,
// for example) use { force: true }: they are applied even if they pass a
// limit, and every later checked charge in that subtree is refused.
//
// A reservation is a guarantee only along a chain of finite grants: an
// unlimited child does not hold anything back in its parent, so what its own
// children reserve is checked again at spend time. Either way no spend can
// pass any ancestor's limit.
//
// Spawning a child charges one unit of `children` to the parent, so a root
// limit of children caps the whole tree, not just its direct children.

export const BUDGET_KINDS = Object.freeze(['tokens', 'usd', 'requests', 'steps', 'children']);

export class BudgetLimitError extends Error {
  constructor(kind, node, needed, available) {
    const label = node && node.name ? ' of ' + node.name : '';
    super(kind === 'children'
      ? 'Stopped before starting another subagent: the budget' + label + ' allows no more children.'
      : !(needed > 0) ? 'Stopped before a model request: the ' + kind + ' budget' + label + ' is used up.'
      : 'Stopped before spending ' + formatAmount(kind, needed) + ': the ' + kind + ' budget' + label + ' has ' + formatAmount(kind, Math.max(0, available)) + ' left.');
    this.code = 'NEURON_BUDGET_EXCEEDED';
    this.kind = kind;
    this.needed = needed;
    this.available = available;
  }
}

function formatAmount(kind, value) {
  if (kind === 'usd') return '$' + Number(value).toFixed(4);
  return String(Math.ceil(value)) + ' ' + kind;
}

function cleanLimits(limits = {}) {
  const out = {};
  for (const kind of BUDGET_KINDS) {
    const value = Number(limits && limits[kind]);
    out[kind] = Number.isFinite(value) && value >= 0 ? value : Infinity;
  }
  return out;
}

function zeroes() {
  const out = {};
  for (const kind of BUDGET_KINDS) out[kind] = 0;
  return out;
}

export function createBudget(limits = {}, { name = 'root' } = {}) {
  return { name, limits: cleanLimits(limits), spent: zeroes(), parent: null, children: new Set(), closed: false };
}

/** What the parent still holds back for an open child. */
function outstanding(child, kind) {
  if (child.closed || !Number.isFinite(child.limits[kind])) return 0;
  return Math.max(0, child.limits[kind] - child.spent[kind]);
}

/** spent plus open reservations: what the node has committed. */
export function committed(node, kind) {
  let total = node.spent[kind];
  for (const child of node.children) total += outstanding(child, kind);
  return total;
}

/** How much of `kind` the node can still spend or hand out. */
export function available(node, kind) {
  // At each ancestor, the open reservation of the child on the path to this
  // node is already held for it, so it counts as available here.
  let left = Infinity;
  let below = null;
  for (let x = node; x; x = x.parent) {
    left = Math.min(left, x.limits[kind] - committedExcept(x, kind, below));
    below = x;
  }
  return left;
}

function committedExcept(node, kind, skipChild) {
  let total = node.spent[kind];
  for (const child of node.children) if (child !== skipChild) total += outstanding(child, kind);
  return total;
}

// Walks from the node to the root and returns the first level that would pass
// its limit if `amount` of `kind` were spent at `node`, or null.
function firstBreach(node, kind, amount) {
  // `delta` is how much the commitment of the current level grows. At the
  // spending node it is the whole amount. One level up, the part that the
  // child's open reservation already covered moves from reserved to spent and
  // does not grow the parent's commitment.
  let delta = amount;
  let below = null;
  let belowSpentBefore = 0;
  for (let x = node; x; x = x.parent) {
    if (below) {
      const grant = below.limits[kind];
      if (!below.closed && Number.isFinite(grant)) {
        const reservedBefore = Math.max(0, grant - belowSpentBefore);
        const reservedAfter = Math.max(0, grant - belowSpentBefore - amount);
        delta = amount - (reservedBefore - reservedAfter);
      } else {
        delta = amount;
      }
    }
    if (delta > 0 && committed(x, kind) + delta > x.limits[kind] + 1e-9) {
      return { node: x, available: x.limits[kind] - committed(x, kind) };
    }
    below = x;
    belowSpentBefore = x.spent[kind];
  }
  return null;
}

/** True when `amount` of `kind` can be spent at `node` without passing a limit. */
export function canSpend(node, kind, amount) {
  if (!node || !BUDGET_KINDS.includes(kind)) return true;
  const value = Math.max(0, Number(amount) || 0);
  if (value === 0) return available(node, kind) > 1e-9;
  return !firstBreach(node, kind, value);
}

/**
 * Spends `amounts` ({ tokens, usd, ... }) at `node` and all its ancestors.
 * Checked charges are all or nothing; { force: true } records them anyway.
 */
export function spend(node, amounts = {}, { force = false } = {}) {
  if (!node) return;
  if (node.closed && !force) throw new Error('This budget is closed: its neuron has ended.');
  const entries = [];
  for (const kind of BUDGET_KINDS) {
    const value = Math.max(0, Number(amounts[kind]) || 0);
    if (value > 0) entries.push([kind, value]);
  }
  if (!force) {
    for (const [kind, value] of entries) {
      const breach = firstBreach(node, kind, value);
      if (breach) throw new BudgetLimitError(kind, breach.node, value, breach.available);
    }
  }
  for (const [kind, value] of entries) for (let x = node; x; x = x.parent) x.spent[kind] += value;
}

/**
 * Starts a child budget. `request` asks for limits per kind; each grant is the
 * smaller of the request and what the parent can still hand out. A kind the
 * request leaves out is unlimited for the child but still bounded by every
 * ancestor at spend time. Charges one child to the parent.
 */
export function reserve(parent, request = {}, { name = 'child' } = {}) {
  if (!parent) return createBudget(request, { name });
  if (parent.closed) throw new Error('This budget is closed: its neuron has ended.');
  spend(parent, { children: 1 });
  const wanted = cleanLimits(request);
  const limits = {};
  for (const kind of BUDGET_KINDS) {
    if (!Number.isFinite(wanted[kind])) { limits[kind] = Infinity; continue; }
    limits[kind] = Math.max(0, Math.min(wanted[kind], available(parent, kind)));
  }
  const child = { name, limits, spent: zeroes(), parent, children: new Set(), closed: false };
  parent.children.add(child);
  return child;
}

/**
 * Ends a budget. What it did not spend goes back to its parent; what it spent
 * stays spent. Returns the refund per kind. A descendant still running (a
 * background agent can outlive the run that started it) keeps its own limit
 * and is checked against every ancestor when it spends, so it cannot use the
 * refund to pass any of them.
 */
export function close(node) {
  const refund = zeroes();
  if (!node || node.closed) return refund;
  for (const kind of BUDGET_KINDS) refund[kind] = outstanding(node, kind);
  node.closed = true;
  return refund;
}

export function budgetSnapshot(node) {
  if (!node) return null;
  const finite = (value) => (Number.isFinite(value) ? value : null);
  const out = { name: node.name, closed: node.closed, spent: { ...node.spent }, limits: {}, available: {} };
  for (const kind of BUDGET_KINDS) {
    out.limits[kind] = finite(node.limits[kind]);
    out.available[kind] = finite(available(node, kind));
  }
  return out;
}

/**
 * The budget node of a session. A root session gets one on first use, with
 * its --max-total-tokens, --max-budget-usd and --max-requests as limits and
 * what the shared ledger already counted as spent. A subagent's node is set
 * when its run starts (see agent-subagents.mjs).
 */
export function sessionBudget(session) {
  if (!session || typeof session !== 'object') return null;
  if (session.budgetNode) return session.budgetNode;
  if (session.subagentDepth > 0 && session.agentId) return null;
  const positive = (value) => (Number(value) > 0 ? Number(value) : undefined);
  const node = createBudget({ tokens: positive(session.maxTotalTokens), usd: positive(session.maxBudgetUsd), requests: positive(session.maxRequests) }, { name: 'main session' });
  const ledger = session.budgetLedger || {};
  node.spent.tokens = Math.max(0, Number(ledger.tokens) || 0);
  node.spent.usd = Math.max(0, Number(ledger.spentUsd) || Number(session.costUsd) || 0);
  node.spent.requests = Math.max(0, Number(ledger.requests) || 0);
  session.budgetNode = node;
  return node;
}

/**
 * Reads a per-child budget request from an agent definition and the
 * OASIS_SUBAGENT_BUDGET default ("tokens=200000,usd=0.5,requests=40,children=4").
 * The definition wins per kind. Returns null when neither sets anything.
 */
export function childBudgetRequest(definition = {}, env = process.env) {
  const request = {};
  const raw = String((env && env.OASIS_SUBAGENT_BUDGET) || '');
  for (const part of raw.split(/[,;\s]+/)) {
    const match = /^([a-z]+)\s*[=:]\s*([0-9.]+)$/i.exec(part.trim());
    if (match && BUDGET_KINDS.includes(match[1].toLowerCase())) request[match[1].toLowerCase()] = Number(match[2]);
  }
  const budget = definition && definition.budget;
  if (budget && typeof budget === 'object') {
    for (const kind of BUDGET_KINDS) {
      const value = Number(budget[kind]);
      if (Number.isFinite(value) && value >= 0) request[kind] = value;
    }
  }
  return Object.keys(request).length ? request : null;
}
