// Per-endpoint request gate. Some free endpoints serve one request at a time
// per client (Pollinations' keyless API answers 429 "Your previous request is
// still running ... 1 request at a time per IP"). Agents running together then
// collide, retry into each other and fail. Once an endpoint says so, its
// requests queue here and take turns, so every agent still finishes.
//
// The limit is learned at runtime (or set with the maxConcurrentRequests config
// key / OASIS_MAX_CONCURRENT_REQUESTS). Unlimited endpoints never wait.

const gates = new Map();

function keyFor(config = {}) {
  try {
    const url = new URL(String(config.baseURL || ''));
    return url.host.toLowerCase() + url.pathname.replace(/\/+$/, '');
  } catch { return String(config.baseURL || 'default'); }
}

function configuredLimit(config = {}, env = process.env) {
  const raw = config.maxConcurrentRequests ?? env.OASIS_MAX_CONCURRENT_REQUESTS;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 1 && value <= 64 ? value : Infinity;
}

function gateFor(config, env) {
  const key = keyFor(config);
  let gate = gates.get(key);
  if (!gate) {
    gate = { key, limit: Infinity, active: 0, queue: [], learned: false };
    gates.set(key, gate);
  }
  const configured = configuredLimit(config, env);
  if (configured !== Infinity && !gate.learned) gate.limit = configured;
  return gate;
}

function pump(gate) {
  while (gate.queue.length && gate.active < gate.limit) {
    const next = gate.queue.shift();
    gate.active++;
    next.resolve();
  }
}

function waitTurn(gate, signal) {
  if (gate.active < gate.limit && !gate.queue.length) { gate.active++; return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const entry = { resolve: () => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); } };
    const onAbort = () => {
      const index = gate.queue.indexOf(entry);
      if (index >= 0) gate.queue.splice(index, 1);
      reject(signal.reason instanceof Error ? signal.reason : Object.assign(new Error('The request was cancelled while waiting for its turn.'), { name: 'AbortError' }));
    };
    if (signal) {
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
    gate.queue.push(entry);
  });
}

// Takes a turn on the endpoint. Returns a handle: release() when the reply is
// fully read; requeue() after the endpoint said "one at a time", which lowers
// the limit and waits for the next turn.
export async function acquireEndpoint(config, { env = process.env, signal } = {}) {
  const gate = gateFor(config, env);
  await waitTurn(gate, signal);
  let held = true;
  return {
    get waiting() { return gate.queue.length; },
    get limit() { return gate.limit; },
    release() {
      if (!held) return;
      held = false;
      gate.active = Math.max(0, gate.active - 1);
      pump(gate);
    },
    async requeue(limit = 1) {
      if (gate.limit > limit) { gate.limit = limit; gate.learned = true; }
      if (held) { held = false; gate.active = Math.max(0, gate.active - 1); pump(gate); }
      await waitTurn(gate, signal);
      held = true;
    }
  };
}

export function endpointGateState(config) {
  const gate = gates.get(keyFor(config));
  return gate ? { limit: gate.limit, active: gate.active, waiting: gate.queue.length, learned: gate.learned } : { limit: Infinity, active: 0, waiting: 0, learned: false };
}

export function resetEndpointGates() { gates.clear(); }
