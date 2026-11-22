// Serializable approval state for background agents (roadmap 2.1, adapted
// from the interruption/resume model in OpenAI Agents JS, MIT).
//
// A background agent has nobody to ask. It used to get a silent "no". Now the
// request is parked on its record: the agent is told the call is waiting for
// the user and goes on without it, and the request is saved with the session.
// It survives a restart. When the user answers (/tasks approve or deny), a
// one-time grant for exactly that call (tool plus arguments) is stored and
// the agent is resumed with the answer. Its next identical call uses the
// grant up, so the tool runs once; a repeat asks again.
import { createHash, randomBytes } from 'node:crypto';

const MAX_PENDING = 5;
const MAX_GRANTS = 10;
// An unanswered request lapses after a day: by then the agent's plan and the
// workspace have moved on, and a yes would resume it on stale ground. A grant
// has to be used soon after the user approves it (the agent is resumed at
// once); an unused one does not linger as a standing permission.
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const GRANT_TTL_MS = 30 * 60 * 1000;

function fresh(at, ttl, now) {
  const time = Date.parse(String(at || ''));
  return Number.isFinite(time) && now - time >= -5 * 60 * 1000 && now - time <= ttl; // small allowance for clock skew
}

function liveGrants(record, now = Date.now()) {
  const grants = Array.isArray(record && record.approvalGrants) ? record.approvalGrants : [];
  const kept = grants.filter((grant) => grant && typeof grant === 'object' && /^[0-9a-f]{32}$/.test(String(grant.digest)) && fresh(grant.at, GRANT_TTL_MS, now));
  if (record) record.approvalGrants = kept;
  return kept;
}

function livePending(record, now = Date.now()) {
  const pending = Array.isArray(record && record.pendingApprovals) ? record.pendingApprovals : [];
  const kept = pending.filter((item) => item && fresh(item.requestedAt, PENDING_TTL_MS, now));
  if (record) record.pendingApprovals = kept;
  return kept;
}

function stable(value) {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stable(value[key])).join(',') + '}';
  return JSON.stringify(value === undefined ? null : value);
}

/** Identifies one call: the tool and its (redacted) arguments. */
export function callDigest(tool, input) {
  return createHash('sha256').update(String(tool || '') + '\n' + stable(input ?? {})).digest('hex').slice(0, 32);
}

function preview(input) {
  try { return JSON.stringify(input ?? {}).slice(0, 2000); } catch { return '{}'; }
}

/** Requests still waiting for an answer (expired ones are dropped). */
export function waitingApprovals(record) {
  return record ? livePending(record) : [];
}

/** Uses up a matching grant. True when this exact call was approved. */
export function consumeGrant(record, tool, input, now = Date.now()) {
  const grants = liveGrants(record, now);
  const digest = callDigest(tool, input);
  const index = grants.findIndex((grant) => grant.digest === digest);
  if (index < 0) return false;
  grants.splice(index, 1);
  return true;
}

/**
 * Parks a request from a background agent and returns false (not approved
 * now). The agent gets a note at its next step; `onParked` lets the caller
 * record an event and notify the user.
 */
export function parkApproval(record, { message = '', tool = '', input = {} } = {}, { onParked } = {}) {
  const pending = livePending(record);
  const digest = callDigest(tool, input);
  let entry = pending.find((item) => item.digest === digest);
  if (!entry) {
    entry = { id: 'approval_' + randomBytes(4).toString('hex'), tool: String(tool || 'tool').slice(0, 100), message: String(message || '').slice(0, 1000), input: preview(input), digest, requestedAt: new Date().toISOString() };
    pending.push(entry);
    if (pending.length > MAX_PENDING) pending.splice(0, pending.length - MAX_PENDING);
    if (typeof onParked === 'function') { try { onParked(entry); } catch {} }
  }
  if (record.child) {
    (record.child.inbox ||= []).push({ text: 'Your ' + entry.tool + ' call needs the user\'s approval, and nobody can answer while you run in the background. The request is saved (' + entry.id + '); the user will approve or deny it later, and you will be resumed with the answer. Do not retry it now: finish what you can without it, and say in your report that this step is waiting for approval.' });
  }
  return false;
}

/**
 * Answers a parked request. Returns the message to resume the agent with.
 * `approvalId` may be omitted when the agent has exactly one request.
 */
export function answerApproval(record, { allow, approvalId = '' } = {}, now = Date.now()) {
  const before = Array.isArray(record && record.pendingApprovals) ? record.pendingApprovals.length : 0;
  const pending = record ? livePending(record, now) : [];
  if (!pending.length) throw new Error('Agent ' + (record && record.id) + (before ? '\'s waiting request expired (requests lapse after 24 hours). Run the step again if it is still needed.' : ' has no request waiting for approval.'));
  const wanted = String(approvalId || '').trim();
  if (!wanted && pending.length > 1) throw new Error('Agent ' + record.id + ' has ' + pending.length + ' requests waiting: name one of ' + pending.map((item) => item.id).join(', ') + '.');
  const index = wanted ? pending.findIndex((item) => item.id === wanted) : 0;
  if (index < 0) throw new Error('No request ' + wanted + ' for agent ' + record.id + '.');
  const [entry] = pending.splice(index, 1);
  if (allow) {
    const grants = liveGrants(record, now).filter((grant) => grant.digest !== entry.digest);
    grants.push({ digest: entry.digest, at: new Date(now).toISOString() });
    record.approvalGrants = grants;
    if (grants.length > MAX_GRANTS) grants.splice(0, grants.length - MAX_GRANTS);
  }
  const message = allow
    ? 'The user approved your waiting request ' + entry.id + ': ' + entry.tool + ' ' + entry.input + '. Make that exact call once now (same tool, same arguments), then continue the task and report.'
    : 'The user denied your waiting request ' + entry.id + ' (' + entry.tool + '). Do not try it again or work around it; finish without it and say so in your report.';
  return { entry, allow: Boolean(allow), message };
}

/** The parts saved with the session. */
export function approvalSnapshot(record) {
  const pending = (Array.isArray(record.pendingApprovals) ? record.pendingApprovals : []).slice(-MAX_PENDING)
    .filter((item) => item && /^approval_[0-9a-f]{8}$/.test(item.id) && /^[0-9a-f]{32}$/.test(item.digest))
    .map((item) => ({ id: item.id, tool: String(item.tool).slice(0, 100), message: String(item.message || '').slice(0, 1000), input: String(item.input || '').slice(0, 2000), digest: item.digest, requestedAt: String(item.requestedAt || '').slice(0, 40) }));
  const grants = liveGrants({ approvalGrants: record.approvalGrants }).map((grant) => ({ digest: grant.digest, at: String(grant.at).slice(0, 40) })).slice(-MAX_GRANTS);
  return { ...(pending.length ? { pendingApprovals: pending } : {}), ...(grants.length ? { approvalGrants: grants } : {}) };
}

/** Restores what approvalSnapshot saved, dropping anything malformed. */
export function restoreApprovals(snapshot = {}) {
  return approvalSnapshot({ pendingApprovals: snapshot.pendingApprovals, approvalGrants: snapshot.approvalGrants });
}
