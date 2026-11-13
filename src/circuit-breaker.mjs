// Provider circuit breakers for the fallback chain, built on cockatiel
// (https://github.com/connor4312/cockatiel, MIT, zero dependencies).
//
// One breaker per provider endpoint and model. Every model request on a session with a
// fallback chain runs through `runWithProviderBreaker`. After `threshold`
// consecutive failures that point at the provider (overloaded, unreachable,
// rate limited, out of credit) the breaker opens: further calls fail at once
// with a BrokenCircuitError instead of waiting on a dead endpoint, and the
// fallback chain moves on. After a cooldown one probe request is let through
// (half-open); success closes the breaker, failure reopens it with a longer
// cooldown (exponential, capped). Purely in-memory and shared by the main
// agent and its subagents within one process.
import { circuitBreaker, ConsecutiveBreaker, ExponentialBackoff, CircuitState, handleWhen, isBrokenCircuitError, noJitterGenerator } from 'cockatiel';

const DEFAULT_THRESHOLD = 2;
const DEFAULT_COOLDOWN_MS = 30000;
const DEFAULT_MAX_COOLDOWN_MS = 30 * 60000;

const breakers = new Map(); // key -> { policy, openedAt, cooldownMs, trip }

function key(provider) {
  return String(provider || 'default').trim().toLowerCase();
}

// One breaker per provider endpoint and model: a rate limit or a missing
// credit on one model must not block a sibling model on the same provider.
export function providerBreakerKey(config) {
  if (!config) return 'default';
  const base = String(config.fallbackProvider || config.baseURL || config.protocol || 'default').trim().replace(/\/+$/, '');
  return key(base + (config.model ? '#' + config.model : ''));
}

// Records every cooldown cockatiel asks for, so isOpen() can answer without
// calling the provider (cockatiel itself only moves to half-open on execute).
function recordingBackoff(factory, entry) {
  const wrap = (backoff) => ({
    get duration() { return backoff.duration; },
    next(context) { const next = wrap(backoff.next(context)); entry.cooldownMs = next.duration; return next; }
  });
  return { next(context) { const backoff = wrap(factory.next(context)); entry.cooldownMs = backoff.duration; return backoff; } };
}

function numberFrom(env, name, fallback, min, max) {
  const value = Number.parseFloat(env && env[name]);
  return Number.isFinite(value) && value >= min ? Math.min(value, max) : fallback;
}

function breakerFor(provider, options = {}) {
  const k = key(provider);
  let entry = breakers.get(k);
  if (entry) return entry;
  const env = options.env || process.env;
  const threshold = Math.round(numberFrom(env, 'OASIS_BREAKER_THRESHOLD', options.threshold || DEFAULT_THRESHOLD, 1, 100));
  const cooldownMs = options.cooldownMs !== undefined ? options.cooldownMs : numberFrom(env, 'OASIS_BREAKER_COOLDOWN_SECONDS', DEFAULT_COOLDOWN_MS / 1000, 0, 3600) * 1000;
  const maxCooldownMs = Math.max(cooldownMs, options.maxCooldownMs !== undefined ? options.maxCooldownMs : DEFAULT_MAX_COOLDOWN_MS);
  entry = { policy: null, openedAt: 0, cooldownMs, trip: () => true };
  // Doubling without jitter: cooldown, 2x, 4x ... capped at maxCooldownMs.
  const backoff = new ExponentialBackoff({ initialDelay: cooldownMs, maxDelay: maxCooldownMs, generator: noJitterGenerator });
  entry.policy = circuitBreaker(handleWhen((error) => entry.trip(error)), {
    halfOpenAfter: recordingBackoff(backoff, entry),
    breaker: new ConsecutiveBreaker(threshold)
  });
  entry.policy.onBreak(() => { entry.openedAt = Date.now(); });
  entry.policy.onReset(() => { entry.openedAt = 0; });
  breakers.set(k, entry);
  return entry;
}

// Runs one provider request through its breaker. `shouldTrip(error)` decides
// whether a failure counts against the provider (a bad request does not).
export async function runWithProviderBreaker(provider, fn, { shouldTrip, signal, env, threshold, cooldownMs, maxCooldownMs } = {}) {
  const entry = breakerFor(provider, { env, threshold, cooldownMs, maxCooldownMs });
  if (typeof shouldTrip === 'function') entry.trip = shouldTrip;
  try {
    return await entry.policy.execute(() => fn(), signal);
  } catch (error) {
    // Say when the next probe goes through, for "circuit breaker open" notes.
    if (isBrokenCircuitError(error)) { try { error.retryInSeconds = retryInSeconds(provider); } catch {} }
    throw error;
  }
}

// True while the provider's breaker is open and its cooldown has not passed.
export function isOpen(provider, now = Date.now()) {
  const entry = breakers.get(key(provider));
  if (!entry) return false;
  const state = entry.policy.state;
  if (state === CircuitState.Isolated) return true;
  if (state !== CircuitState.Open) return false;
  return now - entry.openedAt < entry.cooldownMs;
}

// Seconds until an open breaker lets a probe through (0 when closed).
export function retryInSeconds(provider, now = Date.now()) {
  if (!isOpen(provider, now)) return 0;
  const entry = breakers.get(key(provider));
  return Math.max(1, Math.ceil((entry.openedAt + entry.cooldownMs - now) / 1000));
}

export function isBreakerOpenError(error) {
  return Boolean(error) && isBrokenCircuitError(error);
}

// Reset all state (tests, and /model switching to a fresh provider setup).
export function reset() {
  breakers.clear();
}
