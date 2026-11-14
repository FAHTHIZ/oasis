// Persistent usage and quota ledger, one record per provider, API key and model.
//
// What it keeps (in <config dir>/quota-ledger.json, mode 0600):
// - today's requests, tokens and failures (UTC day, like most free tiers);
// - the limits and remaining capacity a provider last reported in its
//   rate-limit headers, with the time they were reported. They describe that
//   moment, not a guarantee, and are shown that way;
// - a cooldown after a quota failure, marked "provider" when the provider said
//   when it resets and "guess" when it did not.
//
// The split between provider-stated and guessed cooldowns, the escalating
// guess (2 min, 10 min, 1 h) applied only to real quota signals, and exempting
// local endpoints come from FreeLLMAPI's services/ratelimit.ts. Unlike it, no
// database or server is involved, and a guess never blocks your only model:
// a guessed cooldown is only skipped when a fallback model exists.
//
// Keys are never stored: a key is identified by the first 10 hex characters of
// its SHA-256. OASIS_QUOTA_LEDGER=off turns the ledger off.
// Several Oasis processes may update the file at once; each write re-reads it
// and changes only its own record, so a lost update is possible but rare and
// only affects counts.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';
import { rateLimitResetMs, shortRateLimitMs, isHardQuotaError, formatWait } from './provider-retry.mjs';
import { isLocalProvider } from './pricing.mjs';

const VERSION = 1;
const MINUTE = 60_000;
const GUESS_LADDER_MS = [2 * MINUTE, 10 * MINUTE, 60 * MINUTE];
const DAY = 24 * 60 * MINUTE;
const MAX_RECORDS = 500;

export function ledgerEnabled(env = process.env) {
  return !/^(?:0|off|false|no)$/i.test(String(env && env.OASIS_QUOTA_LEDGER || ''));
}

export function ledgerPath(env = process.env) {
  return path.join(getConfigDirectory(env), 'quota-ledger.json');
}

export function keyFingerprint(apiKey) {
  const key = String(apiKey || '');
  return key ? crypto.createHash('sha256').update(key).digest('hex').slice(0, 10) : 'no-key';
}

function providerName(config = {}) {
  if (config.fallbackProvider) return String(config.fallbackProvider);
  try { return new URL(String(config.baseURL || '')).host || String(config.protocol || 'unknown'); } catch { return String(config.protocol || 'unknown'); }
}

/** The ledger identity of a request: provider, key fingerprint and model. */
export function quotaRoute(config = {}, apiKey = '') {
  const provider = providerName(config);
  const key = keyFingerprint(apiKey);
  const model = String(config.model || '');
  return { id: provider + '|' + key + '|' + model, provider, key, model, local: isLocalProvider(config) };
}

function today(now) { return new Date(now).toISOString().slice(0, 10); }

function readLedger(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (data && data.version === VERSION && data.routes && typeof data.routes === 'object') return data;
  } catch { /* missing or unreadable: start fresh */ }
  return { version: VERSION, routes: {} };
}

function writeLedger(file, data) {
  const ids = Object.keys(data.routes);
  if (ids.length > MAX_RECORDS) {
    ids.sort((a, b) => (data.routes[a].lastAt || 0) - (data.routes[b].lastAt || 0));
    for (const id of ids.slice(0, ids.length - MAX_RECORDS)) delete data.routes[id];
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + '.' + process.pid + '.' + crypto.randomBytes(4).toString('hex') + '.tmp';
  fs.writeFileSync(temp, JSON.stringify(data, null, 1) + '\n', { mode: 0o600 });
  fs.renameSync(temp, file);
}

function freshRecord(route, now) {
  return { provider: route.provider, key: route.key, model: route.model, local: route.local, day: today(now), requests: 0, inputTokens: 0, outputTokens: 0, failures: 0, quotaFailures: 0, lastAt: now };
}

function update(route, env, now, change) {
  if (!route || !ledgerEnabled(env)) return null;
  const file = ledgerPath(env);
  try {
    const data = readLedger(file);
    let record = data.routes[route.id] || freshRecord(route, now);
    // A new UTC day resets the daily counts; reported limits and cooldowns stay
    // until they expire on their own.
    if (record.day !== today(now)) record = { ...record, day: today(now), requests: 0, inputTokens: 0, outputTokens: 0, failures: 0, quotaFailures: 0 };
    change(record);
    record.lastAt = now;
    data.routes[route.id] = record;
    writeLedger(file, data);
    return record;
  } catch { return null; }
}

function header(headers, name) {
  if (!headers) return '';
  const value = typeof headers.get === 'function' ? headers.get(name) : headers[name] || headers[name.toLowerCase()];
  return value === null || value === undefined ? '' : String(value).trim();
}

function number(value) {
  if (value === '' || value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// x-ratelimit-reset is a duration ("6m0s", "20s") on OpenAI and Groq and an
// epoch timestamp in milliseconds on OpenRouter.
function resetAt(value, now) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{12,14}$/.test(text)) return Number(text);
  if (/^\d{9,11}$/.test(text)) return Number(text) * 1000;
  const parsed = Date.parse(text);
  if (/\d{4}-\d\d-\d\d/.test(text) && Number.isFinite(parsed)) return parsed;
  const ms = rateLimitResetMs({ get: (name) => (name === 'x-ratelimit-reset-requests' ? text : '') }, now);
  return ms === null ? null : now + ms;
}

/** Limits and remaining capacity stated in response headers, or null. */
export function reportedLimits(headers, now = Date.now()) {
  const out = {};
  const families = [
    ['requests', 'x-ratelimit-limit-requests', 'x-ratelimit-remaining-requests', 'x-ratelimit-reset-requests'],
    ['tokens', 'x-ratelimit-limit-tokens', 'x-ratelimit-remaining-tokens', 'x-ratelimit-reset-tokens'],
    ['requests', 'anthropic-ratelimit-requests-limit', 'anthropic-ratelimit-requests-remaining', 'anthropic-ratelimit-requests-reset'],
    ['tokens', 'anthropic-ratelimit-tokens-limit', 'anthropic-ratelimit-tokens-remaining', 'anthropic-ratelimit-tokens-reset'],
    ['requests', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset']
  ];
  for (const [kind, limitName, remainingName, resetName] of families) {
    if (out[kind]) continue;
    const limit = number(header(headers, limitName));
    const remaining = number(header(headers, remainingName));
    if (limit === null && remaining === null) continue;
    out[kind] = { limit, remaining, resetAt: resetAt(header(headers, resetName), now) };
  }
  return Object.keys(out).length ? { ...out, at: now } : null;
}

// OpenRouter puts the reset of a daily free-model limit in the error body:
// {"error":{"metadata":{"headers":{"X-RateLimit-Reset":"1731628800000"}}}}.
function bodyResetAt(body) {
  const match = /"x-ratelimit-reset"\s*:\s*"?(\d{10,14})/i.exec(String(body || ''));
  if (!match) return null;
  return match[1].length >= 12 ? Number(match[1]) : Number(match[1]) * 1000;
}

/** True when a failure says a quota or balance is used up (not a per-minute window or an outage). */
export function isQuotaSignal(status, body = '') {
  if (status === 402) return shortRateLimitMs(body) === null;
  if (status === 429) return shortRateLimitMs(body) === null;
  return isHardQuotaError(body);
}

/** Records a successful response: one request, and any limits the provider reported. */
export function recordSuccess(route, { headers, env = process.env, now = Date.now() } = {}) {
  return update(route, env, now, (record) => {
    record.requests += 1;
    record.lastStatus = 200;
    const reported = reportedLimits(headers, now);
    if (reported) record.reported = reported;
    // A served request proves the quota is not used up right now. The cleared
    // state is kept until the body is read: a gateway can still turn out to
    // have answered 200 with an error body (see recordFailure's retract).
    record.retractable = { cooldown: record.cooldown || null, recentQuotaHits: record.recentQuotaHits || [] };
    delete record.cooldown;
    record.recentQuotaHits = [];
  });
}

export function recordTokens(route, usage = {}, { env = process.env, now = Date.now() } = {}) {
  if (!usage) return null;
  return update(route, env, now, (record) => {
    record.inputTokens += Math.max(0, Number(usage.inputTokens) || 0);
    record.outputTokens += Math.max(0, Number(usage.outputTokens) || 0);
  });
}

/** Records a failed response and, for a quota failure, a cooldown. */
//   retract: the same response was first recorded as a success (HTTP 200 with
//   an error body). It is not counted twice, and the quota history the success
//   cleared is restored so repeated quota errors still climb the ladder.
export function recordFailure(route, { status = 0, headers, body = '', env = process.env, now = Date.now(), retract = false } = {}) {
  return update(route, env, now, (record) => {
    if (retract && record.retractable) {
      if (record.retractable.cooldown) record.cooldown = record.retractable.cooldown;
      record.recentQuotaHits = record.retractable.recentQuotaHits;
    } else record.requests += 1;
    delete record.retractable;
    record.failures += 1;
    record.lastStatus = status;
    const reported = reportedLimits(headers, now);
    if (reported) record.reported = reported;
    if (!isQuotaSignal(status, body)) return;
    record.quotaFailures += 1;
    // A local server answering 429 is busy, not out of quota.
    if (route.local) return;
    const statedMs = rateLimitResetMs(headers, now);
    const stated = statedMs !== null ? now + statedMs : bodyResetAt(body) || (reported && reported.requests && reported.requests.remaining === 0 ? reported.requests.resetAt : null);
    if (stated && stated > now) {
      record.cooldown = { until: Math.min(stated, now + 2 * DAY), source: 'provider', status };
      return;
    }
    const hits = (Array.isArray(record.recentQuotaHits) ? record.recentQuotaHits : []).filter((at) => now - at < DAY);
    hits.push(now);
    record.recentQuotaHits = hits.slice(-GUESS_LADDER_MS.length);
    record.cooldown = { until: now + GUESS_LADDER_MS[Math.min(hits.length, GUESS_LADDER_MS.length) - 1], source: 'guess', status };
  });
}

export function readRoute(route, env = process.env) {
  if (!route || !ledgerEnabled(env)) return null;
  return readLedger(ledgerPath(env)).routes[route.id] || null;
}

export class QuotaCooldownError extends Error {
  constructor(route, cooldown, now) {
    const wait = formatWait(cooldown.until - now);
    super('Skipped ' + route.model + ' on ' + route.provider + ' without sending a request: ' + (cooldown.source === 'provider'
      ? 'the provider reported its quota used up until ' + new Date(cooldown.until).toISOString() + ' (in ' + wait + ').'
      : 'it failed with a quota error recently (' + cooldown.status + '), so it rests for ' + wait + ' while a fallback model is tried.') + ' `oasis quota` shows the record; `oasis quota --reset` clears it.');
    this.code = 'OASIS_QUOTA_COOLDOWN';
    this.status = 429;
    this.retryInSeconds = Math.ceil((cooldown.until - now) / 1000);
    this.cooldownSource = cooldown.source;
  }
}

/**
 * Before sending: throws QuotaCooldownError when the route is cooling down.
 * A provider-stated cooldown always applies; a guessed one only when there
 * is a fallback to move to, so your only model is never refused on a guess.
 */
export function assertRouteAvailable(route, { env = process.env, hasFallback = false, now = Date.now() } = {}) {
  const record = readRoute(route, env);
  const cooldown = record && record.cooldown;
  if (!cooldown || !(cooldown.until > now)) return record;
  if (cooldown.source === 'guess' && !hasFallback) return record;
  throw new QuotaCooldownError(route, cooldown, now);
}

export function listRoutes(env = process.env) {
  return Object.entries(readLedger(ledgerPath(env)).routes).map(([id, record]) => ({ id, ...record }));
}

export function resetLedger(env = process.env, match = '') {
  const file = ledgerPath(env);
  const data = readLedger(file);
  let removed = 0;
  for (const id of Object.keys(data.routes)) {
    if (match && !id.toLowerCase().includes(match.toLowerCase())) continue;
    delete data.routes[id];
    removed++;
  }
  if (removed) writeLedger(file, data);
  return removed;
}

function ago(ms) {
  return ms < MINUTE ? Math.round(ms / 1000) + 's ago' : ms < 60 * MINUTE ? Math.round(ms / MINUTE) + ' min ago' : Math.round(ms / (60 * MINUTE)) + ' h ago';
}

/** Human-readable report for `oasis quota`. */
export function formatQuotaReport(routes, now = Date.now()) {
  if (!routes.length) return 'No model usage recorded yet. Oasis records usage per provider, key and model as requests are made.\n';
  const lines = ['Model usage today (UTC) per provider, key and model. Keys are shown as SHA-256 fingerprints.', ''];
  const sorted = [...routes].sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0));
  for (const route of sorted) {
    const isToday = route.day === today(now);
    lines.push(route.model + '  on ' + route.provider + '  key ' + route.key + (route.local ? '  (local)' : ''));
    lines.push('  today: ' + (isToday ? route.requests + ' requests, ' + route.inputTokens + ' input + ' + route.outputTokens + ' output tokens' + (route.failures ? ', ' + route.failures + ' failed' + (route.quotaFailures ? ' (' + route.quotaFailures + ' quota)' : '') : '') : 'no requests'));
    const reported = route.reported;
    if (reported) {
      const parts = ['requests', 'tokens'].filter((kind) => reported[kind]).map((kind) => {
        const item = reported[kind];
        return kind + ' ' + (item.remaining ?? '?') + ' of ' + (item.limit ?? '?') + ' left' + (item.resetAt ? ', resets ' + new Date(item.resetAt).toISOString() : '');
      });
      lines.push('  reported by the provider ' + ago(now - reported.at) + ': ' + parts.join('; ') + ' (a snapshot of that moment, not a guarantee)');
    } else {
      lines.push('  remaining quota: unknown (the provider sent no rate-limit headers)');
    }
    if (route.cooldown && route.cooldown.until > now) {
      lines.push('  cooling down until ' + new Date(route.cooldown.until).toISOString() + ' (' + (route.cooldown.source === 'provider' ? 'reset time stated by the provider' : 'guessed after a quota error; applies only when a fallback model exists') + ')');
    }
    lines.push('');
  }
  return lines.join('\n');
}
