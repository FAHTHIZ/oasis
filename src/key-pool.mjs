// API key pools: spread one provider's traffic over several keys and move to
// the next key immediately when one is rate-limited (429) or rejected
// (401/402/403), instead of waiting out backoff on a single key.
//
//   OASIS_API_KEY_POOL="key-a,key-b key-c"   (comma, space or newline separated)
//   OASIS_API_KEY_POOL_FILE=/path/to/keys     (one key per line, # comments)
//
// The configured API key, when set, is always part of the pool. Rate-limited
// keys cool down for the provider's Retry-After (default 60 s); rejected keys
// are skipped for the rest of the process. Keys are never logged; status
// output shows only the last four characters.
import { readFileSync, statSync } from 'node:fs';

const DEFAULT_COOLDOWN_MS = 60000;
const REJECTED_MS = 24 * 3600000;
const MAX_KEYS = 64;

export function parseKeyList(text) {
  return [...new Set(String(text || '').split(/\r?\n/).map((line) => line.replace(/#.*$/, '')).join(' ').split(/[\s,]+/).map((key) => key.trim()).filter((key) => key.length >= 8 && !/[\u0000-\u001f]/.test(key)))].slice(0, MAX_KEYS);
}

export function poolKeysFromEnv(env = process.env, primary = '') {
  let keys = parseKeyList(env.OASIS_API_KEY_POOL);
  if (env.OASIS_API_KEY_POOL_FILE) {
    const info = statSync(env.OASIS_API_KEY_POOL_FILE, { throwIfNoEntry: false });
    if (!info || !info.isFile() || info.size > 65536) throw new Error('OASIS_API_KEY_POOL_FILE must be a regular file under 64 KB.');
    if (process.platform !== 'win32' && (info.mode & 0o077)) throw new Error('OASIS_API_KEY_POOL_FILE is readable by other users; run chmod 600 on it.');
    keys = keys.concat(parseKeyList(readFileSync(env.OASIS_API_KEY_POOL_FILE, 'utf8')));
  }
  if (primary) keys.unshift(String(primary));
  return [...new Set(keys)].slice(0, MAX_KEYS);
}

export function maskKey(key) {
  const text = String(key || '');
  return text.length <= 4 ? '****' : '…' + text.slice(-4);
}

export function createKeyPool(keys, options = {}) {
  const now = options.now || Date.now;
  const list = [...new Set((keys || []).filter(Boolean))];
  const state = list.map((key) => ({ key, until: 0, failures: 0, uses: 0, lastStatus: 0 }));
  let index = 0;
  const available = (entry) => entry.until <= now();
  return {
    size: state.length,
    current() {
      if (!state.length) return '';
      for (let step = 0; step < state.length; step++) {
        const entry = state[(index + step) % state.length];
        if (available(entry)) { index = (index + step) % state.length; entry.uses++; return entry.key; }
      }
      // Everything is cooling down: use the key that frees up first.
      const soonest = state.filter((entry) => entry.lastStatus === 429).sort((a, b) => a.until - b.until)[0];
      return soonest ? soonest.key : '';
    },
    // Records a failure for key and returns the next usable key, or '' when none.
    fail(key, status, retryAfterMs = null) {
      const entry = state.find((item) => item.key === key);
      if (entry) {
        entry.failures++;
        entry.lastStatus = status;
        entry.until = now() + (status === 429 ? Math.max(1000, Number(retryAfterMs) || DEFAULT_COOLDOWN_MS) : REJECTED_MS);
      }
      for (let step = 1; step <= state.length; step++) {
        const next = state[(state.indexOf(entry) + step + state.length) % state.length];
        if (next && next.key !== key && available(next)) { index = state.indexOf(next); return next.key; }
      }
      return '';
    },
    status() {
      return state.map((entry) => ({ key: maskKey(entry.key), available: available(entry), coolingDownMs: Math.max(0, entry.until - now()), failures: entry.failures, uses: entry.uses, lastStatus: entry.lastStatus || null }));
    }
  };
}

// Returns the session's pool (created on first use) or null when fewer than
// two keys are configured.
export function sessionKeyPool(session, env, primary) {
  if (session.apiKeyPool !== undefined) return session.apiKeyPool;
  let keys = [];
  try { keys = poolKeysFromEnv(env, primary); } catch (error) { session.apiKeyPoolError = error.message; }
  session.apiKeyPool = keys.length > 1 ? createKeyPool(keys) : null;
  return session.apiKeyPool;
}

export const ROTATE_STATUSES = new Set([401, 402, 403, 429]);
