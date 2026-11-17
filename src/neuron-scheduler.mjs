// Oasis Neuron Network scheduler (roadmap 1.2): one admission point for every
// neuron, whether it was started by `task`, a team or a workflow's agent().
//
// A neuron runs only while it holds a slot. Slots are limited three ways:
//   - the whole network: at most `globalCap` neurons run at once (default 8);
//   - per parent: at most `childrenCap` of one parent's children (default 8);
//   - per provider: at most `providerSlots[provider]` on one provider, when set.
// Requests past a limit wait in FIFO order (a later request that fits is not
// held back by an earlier one that does not) and learn why they waited.
//
// Deadlock: a parent blocked on foreground children parks its slot (gives it
// up) until the last of them returns, then takes a slot again. Only neurons
// that are working hold slots, so a full network of parents waiting on their
// children cannot happen: waiting holds nothing, and working always ends.

export const NETWORK_RUNNING_CAP = 8;
export const DEFAULT_CHILDREN_CAP = 8;

function positiveInt(value, fallback, max = 64) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 1 ? Math.min(max, number) : fallback;
}

/** Parse `host=2,other=1` (OASIS_PROVIDER_SLOTS) or an object of provider → slots. */
export function parseProviderSlots(value) {
  const out = {};
  if (!value) return out;
  const entries = typeof value === 'string'
    ? value.split(',').map((part) => part.split('=').map((piece) => piece.trim()))
    : typeof value === 'object' ? Object.entries(value) : [];
  for (const [name, slots] of entries) {
    const key = String(name || '').toLowerCase().slice(0, 200);
    const count = positiveInt(slots, 0);
    if (key && count) out[key] = count;
  }
  return out;
}

/** The provider key a child's requests count against: the API host, or the protocol name. */
export function providerKey(config) {
  if (!config || typeof config !== 'object') return '';
  const base = String(config.baseUrl || config.baseURL || '');
  if (base) { try { return new URL(base).host.toLowerCase(); } catch {} }
  return String(config.provider || config.protocol || '').toLowerCase().slice(0, 200);
}

export function createNeuronScheduler(options = {}) {
  const globalCap = positiveInt(options.globalCap, NETWORK_RUNNING_CAP);
  const childrenCap = positiveInt(options.childrenCap, DEFAULT_CHILDREN_CAP);
  const providerSlots = parseProviderSlots(options.providerSlots);
  const held = new Map(); // request key -> { id, parentId, provider }
  const queue = [];
  let maxObserved = 0;

  const countWhere = (test) => { let n = 0; for (const slot of held.values()) if (test(slot)) n++; return n; };
  const running = () => held.size;
  const childrenOf = (parentId) => countWhere((slot) => slot.parentId === parentId);
  const onProvider = (provider) => countWhere((slot) => slot.provider === provider);

  function blockedBy(request) {
    if (running() >= globalCap) return { limit: 'network', cap: globalCap, running: running() };
    if (childrenOf(request.parentId) >= childrenCap) return { limit: 'parent', cap: childrenCap, running: childrenOf(request.parentId) };
    const slots = request.provider && providerSlots[request.provider];
    if (slots && onProvider(request.provider) >= slots) return { limit: 'provider', cap: slots, running: onProvider(request.provider), provider: request.provider };
    return null;
  }

  function wait(request, signal, onQueued) {
    const blocked = blockedBy(request);
    if (!blocked) { take(request); return Promise.resolve(null); }
    if (signal && signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        const index = queue.indexOf(request);
        if (index >= 0) queue.splice(index, 1);
        reject(abortError());
      };
      request.resolve = () => resolve(blocked);
      request.cleanup = () => { if (signal) signal.removeEventListener('abort', onAbort); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
      queue.push(request);
      if (typeof onQueued === 'function') { try { onQueued({ ...blocked, position: queue.length }); } catch {} }
    });
  }

  function take(request) {
    held.set(request.key, request);
    maxObserved = Math.max(maxObserved, held.size);
  }

  function pump() {
    for (let i = 0; i < queue.length; i++) {
      const request = queue[i];
      if (blockedBy(request)) continue;
      queue.splice(i, 1);
      i--;
      request.cleanup();
      take(request);
      request.resolve();
    }
  }

  let keys = 0;
  function makeRequest({ id, parentId = 'main', provider = '' }) {
    return { key: ++keys, id: String(id), parentId: String(parentId || 'main'), provider: String(provider || '').toLowerCase() };
  }

  function makeTicket(request, waitedFor, waitedMs) {
    let released = false;
    let parks = 0;
    let resuming = null;
    const ticket = {
      id: request.id,
      waitedFor,
      waitedMs,
      get parked() { return parks > 0; },
      release() {
        if (released) return;
        released = true;
        held.delete(request.key);
        pump();
      },
      /** The neuron is blocked on a foreground child: give the slot up meanwhile. */
      park() {
        if (released) return;
        if (parks++ === 0) { held.delete(request.key); pump(); }
      },
      /** A foreground child returned. After the last one, take a slot again. */
      unpark({ signal = null } = {}) {
        if (released || parks === 0) return Promise.resolve();
        if (--parks > 0) return resuming || Promise.resolve();
        const again = makeRequest(request);
        again.key = request.key;
        resuming = wait(again, signal, null).then(() => { resuming = null; }, (error) => { resuming = null; released = true; throw error; });
        return resuming;
      }
    };
    return ticket;
  }

  return {
    globalCap, childrenCap, providerSlots,
    /** The limit a request would wait on right now, or null if it would start at once. */
    wouldWait(fields) {
      return blockedBy(makeRequest(fields));
    },
    /** Wait for a slot. Rejects with an AbortError when `signal` aborts first. */
    async acquire(fields, { signal = null, onQueued = null } = {}) {
      const request = makeRequest(fields);
      const started = Date.now();
      const waitedFor = await wait(request, signal, onQueued);
      return makeTicket(request, waitedFor, Date.now() - started);
    },
    snapshot() {
      return { running: running(), queued: queue.length, global_cap: globalCap, children_cap: childrenCap, provider_slots: { ...providerSlots }, max_running_observed: maxObserved };
    }
  };
}

function abortError() {
  const error = new Error('The agent was stopped while it waited for a free slot.');
  error.name = 'AbortError';
  return error;
}

/** Plain words for a tool result: why a neuron waited before it started. */
export function describeWait(waitedFor, waitedMs) {
  if (!waitedFor) return '';
  const seconds = Math.max(0, Math.round(waitedMs / 100) / 10);
  const reason = waitedFor.limit === 'network'
    ? waitedFor.running + ' agents were already running across the network (limit ' + waitedFor.cap + ')'
    : waitedFor.limit === 'parent'
      ? 'its parent already had ' + waitedFor.running + ' agents running (limit ' + waitedFor.cap + ')'
      : waitedFor.provider + ' already had ' + waitedFor.running + ' agents using it (limit ' + waitedFor.cap + ')';
  return 'Queued for ' + seconds + ' s before starting: ' + reason + '.';
}

const schedulers = new WeakMap();

/** The scheduler shared by every session that uses this agent registry. */
export function schedulerForRegistry(registry, options = {}) {
  let scheduler = schedulers.get(registry);
  if (!scheduler) {
    scheduler = createNeuronScheduler(options);
    schedulers.set(registry, scheduler);
  }
  return scheduler;
}
