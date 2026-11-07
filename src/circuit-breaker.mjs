// Provider circuit breaker for OASIS.
//
// Tracks consecutive failures per provider endpoint and opens a cooldown
// window after a configurable threshold, so a repeatedly failing provider
// (rate-limited, down, or overloaded) is skipped instead of hammered. A
// successful call resets the count. Purely in-memory; no persistence.

const DEFAULT_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60000;

const state = new Map(); // provider -> { failures, openedAt }

function key(provider) {
  return String(provider || 'default').trim().toLowerCase();
}

// Record a failure. Returns the current failure count after incrementing.
export function recordFailure(provider, { threshold = DEFAULT_THRESHOLD, cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const k = key(provider);
  const entry = state.get(k) || { failures: 0, openedAt: 0 };
  entry.failures += 1;
  if (entry.failures >= threshold && !entry.openedAt) entry.openedAt = Date.now();
  state.set(k, entry);
  return entry.failures;
}

// Record a success. Resets the failure count and closes an open breaker.
export function recordSuccess(provider) {
  const k = key(provider);
  state.delete(k);
}

// True when the provider is in an open (cooling-down) state.
export function isOpen(provider, { cooldownMs = DEFAULT_COOLDOWN_MS } = {}) {
  const entry = state.get(key(provider));
  if (!entry || !entry.openedAt) return false;
  if (Date.now() - entry.openedAt >= cooldownMs) {
    // Cooldown expired: half-open, allow one probe.
    state.delete(key(provider));
    return false;
  }
  return true;
}

// Reset all state (useful for tests).
export function reset() {
  state.clear();
}
