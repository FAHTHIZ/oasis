// Provider retry policy: backoff, Retry-After handling, quota detection.
// Extracted from agent.mjs; agent.mjs re-exports the public names.

// Two quick retries for blips, then (server errors and dropped connections
// only) three patient ones of about 2, 5 and 12 seconds. A live run on
// Google's Gemma endpoint saw three 5xx in a row inside a minute; giving up
// after half a second of backoff failed whole tasks.
// Overloaded providers (Gemini's 503 "high demand" bursts) can stay down for a
// minute; Gemini CLI and Claude Code retry about ten times. Eight patient
// retries wait about 100 seconds in total before giving up.
export const MAX_PROVIDER_RETRIES = 8;
export const QUICK_PROVIDER_RETRIES = 2;
export const PATIENT_RETRY_STEPS_MS = [2000, 5000, 10000, 20000, 30000, 30000];
export const PATIENT_RETRY_STATUSES = new Set([500, 502, 503, 504]);
export const MAX_PROVIDER_RETRY_DELAY_MS = 5000;
// A Retry-After up to this long is waited out exactly (as the OpenAI and
// Anthropic SDKs do). Longer ones are not retried inline: retrying before the
// advertised time only burns attempts against a limit that is still closed,
// so the request falls through to the rate-limit wait, the fallback chain or
// a clear error instead.
export const MAX_INLINE_RETRY_AFTER_MS = 60000;
export const RETRYABLE_PROVIDER_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504]);
// A 429 that means "out of quota / billing / account on hold" will not clear by
// retrying; retrying only burns time (and, on some providers, more quota).
export const HARD_QUOTA_PATTERN = /insufficient_quota|exceeded your current quota|billing|credit balance|payment required|account[_ ](?:is )?(?:on[_ ]hold|suspended|disabled|deactivated)|usage limit reached|weekly limit|monthly limit|spend(?:ing)? limit/i;
// gpt-oss behind some gateways: the server fails to parse the model's own
// harmony output and returns 400 "Unknown role: assistant<|channel|>commentary".
// Our request was valid; the same request usually works on a retry.
export function isMalformedGenerationError(status, text) {
  return status === 400 && /<\|(?:channel|message|start|end|call|constrain|return)\|>/.test(String(text || ''));
}
export function isHardQuotaError(text) {
  return HARD_QUOTA_PATTERN.test(String(text || '')) && shortRateLimitMs(text) === null;
}

// Gemini words a per-minute limit exactly like an exhausted quota ("You
// exceeded your current quota, please check your plan and billing details")
// and tells the real story only in the quota id (...PerMinute...) and
// RetryInfo. Those clear in under a minute, so they are worth one wait on the
// same model instead of a billing error. Returns the wait in ms, or null.
export const SHORT_RATE_LIMIT_MAX_MS = 90000;
// Also covers free endpoints that state a short wait outright, e.g.
// Pollinations' HTTP 402 "1 reply every 45 seconds per IP. Retry after 43s"
// (seen live): an explicit hint of 90 s or less, with no daily, monthly or
// credit wording, is a rate window, not an exhausted balance.
export const EXPLICIT_SHORT_WAIT = /\bretry (?:after|in) (\d+(?:\.\d+)?) ?s(?:ec(?:ond)?s?)?\b/i;
export const LONG_LIMIT_WORDING = /PerDay|per ?day|daily|per ?month|monthly|credit|balance|insufficient|billing/i;
export function shortRateLimitMs(body) {
  const text = String(body || '');
  const explicit = EXPLICIT_SHORT_WAIT.exec(text);
  if (explicit && !/PerMinute|per ?minute/i.test(text) && !LONG_LIMIT_WORDING.test(text)) {
    const ms = Number(explicit[1]) * 1000;
    return Number.isFinite(ms) && ms <= SHORT_RATE_LIMIT_MAX_MS ? Math.ceil(ms) + 500 : null;
  }
  if (!/PerMinute|per ?minute/i.test(text) || /PerDay|per ?day/i.test(text)) return null;
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(text) || /retry in (\d+(?:\.\d+)?)s\b/i.exec(text);
  const ms = delay ? Number(delay[1]) * 1000 : 20000;
  if (!Number.isFinite(ms) || ms > SHORT_RATE_LIMIT_MAX_MS) return null;
  return Math.ceil(ms) + 500;
}

export function parseRetryAfterMs(raw) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (/^\d+(?:\.\d+)?$/.test(value)) {
    return Math.max(0, Number(value) * 1000);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

// When a provider says how long until its rate limit clears. Retry-After first, then
// Anthropic's anthropic-ratelimit-*-reset (RFC 3339) and OpenAI-style
// x-ratelimit-reset-* durations ("1m30s", "250ms"). Uncapped; null when unknown.
export function parseDurationMs(text) {
  const value = String(text || '').trim();
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1000;
  const parts = [...value.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)];
  if (!parts.length || parts.map((p) => p[0]).join('') !== value) return null;
  const unit = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  return parts.reduce((sum, [, n, u]) => sum + Number(n) * unit[u], 0);
}
// "34s" under a minute, "3 min" above.
export function formatWait(ms) {
  const seconds = Math.ceil(Math.max(0, Number(ms) || 0) / 1000);
  return seconds < 60 ? seconds + 's' : Math.ceil(seconds / 60) + ' min';
}

export function rateLimitResetMs(headers, now = Date.now()) {
  const get = (name) => (headers && typeof headers.get === 'function' ? headers.get(name) : headers && headers[name]) || '';
  const retryAfter = String(get('retry-after')).trim();
  if (retryAfter) {
    if (/^\d+(?:\.\d+)?$/.test(retryAfter)) return Number(retryAfter) * 1000;
    const at = Date.parse(retryAfter);
    if (Number.isFinite(at)) return Math.max(0, at - now);
  }
  const waits = [];
  for (const kind of ['requests', 'tokens', 'input-tokens', 'output-tokens']) {
    const at = Date.parse(String(get(`anthropic-ratelimit-${kind}-reset`)));
    if (Number.isFinite(at)) waits.push(Math.max(0, at - now));
  }
  for (const kind of ['requests', 'tokens']) {
    const ms = parseDurationMs(get(`x-ratelimit-reset-${kind}`));
    if (ms !== null) waits.push(ms);
  }
  return waits.length ? Math.max(...waits) : null;
}

// Opt-in for unattended runs: OASIS_WAIT_FOR_RATE_LIMIT_MINUTES=N lets a request that
// is still rate-limited after the normal retries sleep until the advertised reset
// (when it is at most N minutes away, max 24 h) and try again, up to 3 times.
// Billing and out-of-credit errors never wait.
export const RESETTABLE_LIMIT_PATTERN = /usage limit reached|rate.?limit|too many requests/i;
export const BILLING_PATTERN = /insufficient_quota|billing|credit balance|payment required|account[_ ](?:is )?(?:on[_ ]hold|suspended|disabled|deactivated)/i;
export function rateLimitWaitMs({ status, headers, body = '', maxMinutes = 0, now = Date.now() } = {}) {
  const limit = Math.min(1440, Math.max(0, Number(maxMinutes) || 0)) * 60000;
  if (!limit || status !== 429 || BILLING_PATTERN.test(String(body))) return null;
  if (isHardQuotaError(body) && !RESETTABLE_LIMIT_PATTERN.test(String(body))) return null;
  const wait = rateLimitResetMs(headers, now);
  if (wait === null || wait > limit) return null;
  return Math.round(wait + 1000);
}

// How many retries a failure gets. status 0 = the connection itself failed.
// OASIS_PROVIDER_RETRIES caps the total (0 disables retries).
// Tell the UI about retries long enough to notice (quick sub-second retries
// stay silent), so a provider outage reads as "retrying", not as a hang.
export function notifyProviderRetry(options, event) {
  if (!options || typeof options.onProviderRetry !== 'function' || event.waitMs < 1500) return;
  try { options.onProviderRetry(event); } catch {}
}

export function providerErrorSummary(body) {
  const text = String(body || '');
  try {
    const parsed = JSON.parse(text);
    const error = (Array.isArray(parsed) ? parsed[0] : parsed)?.error;
    if (error) return String(typeof error === 'string' ? error : error.message || error.status || '').slice(0, 120);
  } catch {}
  return text.replace(/\s+/g, ' ').trim().slice(0, 120);
}

export function providerRetryLimit(status, env = process.env) {
  const base = status === 0 || PATIENT_RETRY_STATUSES.has(status) ? MAX_PROVIDER_RETRIES : QUICK_PROVIDER_RETRIES;
  // OASIS_PROVIDER_RETRIES sets the retry count for retryable errors (0-20).
  const raw = (env || process.env).OASIS_PROVIDER_RETRIES;
  const wanted = raw === undefined || raw === '' ? NaN : Number(raw);
  if (!Number.isInteger(wanted) || wanted < 0) return base;
  return Math.min(wanted, 20);
}

export function providerRetryDelayMs(retryNumber, retryAfter = null, random = Math.random) {
  const advertised = parseRetryAfterMs(retryAfter);
  if (advertised !== null) return advertised > MAX_INLINE_RETRY_AFTER_MS ? null : advertised;
  // Exponential backoff with jitter (50-100% of the step), so parallel subagents that hit
  // the same rate limit do not all retry in the same instant and collide again.
  const step = retryNumber > QUICK_PROVIDER_RETRIES
    ? PATIENT_RETRY_STEPS_MS[Math.min(PATIENT_RETRY_STEPS_MS.length - 1, retryNumber - QUICK_PROVIDER_RETRIES - 1)]
    : Math.min(MAX_PROVIDER_RETRY_DELAY_MS, 250 * (2 ** Math.max(0, retryNumber - 1)));
  return Math.round(step * (0.5 + 0.5 * Math.min(1, Math.max(0, Number(random()) || 0))));
}

export function waitForProviderRetry(milliseconds, signal) {
  if (signal.aborted) {
    const error = new Error('The model request was cancelled before retry.');
    error.name = 'AbortError';
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const error = new Error('The model request was cancelled during provider retry.');
      error.name = 'AbortError';
      reject(error);
    };
    const timer = setTimeout(finish, Math.max(0, milliseconds));
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
