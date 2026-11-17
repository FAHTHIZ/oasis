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

/** Uses up a matching grant. True when this exact call was approved. */
export function consumeGrant(record, tool, input) {
  const grants = record && Array.isArray(record.approvalGrants) ? record.approvalGrants : [];
  const digest = callDigest(tool, input);
  const index = grants.indexOf(digest);
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
  const pending = record.pendingApprovals ||= [];
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
export function answerApproval(record, { allow, approvalId = '' } = {}) {
  const pending = Array.isArray(record && record.pendingApprovals) ? record.pendingApprovals : [];
  if (!pending.length) throw new Error('Agent ' + (record && record.id) + ' has no request waiting for approval.');
  const wanted = String(approvalId || '').trim();
  if (!wanted && pending.length > 1) throw new Error('Agent ' + record.id + ' has ' + pending.length + ' requests waiting: name one of ' + pending.map((item) => item.id).join(', ') + '.');
  const index = wanted ? pending.findIndex((item) => item.id === wanted) : 0;
  if (index < 0) throw new Error('No request ' + wanted + ' for agent ' + record.id + '.');
  const [entry] = pending.splice(index, 1);
  if (allow) {
    const grants = record.approvalGrants ||= [];
    if (!grants.includes(entry.digest)) grants.push(entry.digest);
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
  const grants = (Array.isArray(record.approvalGrants) ? record.approvalGrants : []).filter((digest) => /^[0-9a-f]{32}$/.test(digest)).slice(-MAX_GRANTS);
  return { ...(pending.length ? { pendingApprovals: pending } : {}), ...(grants.length ? { approvalGrants: grants } : {}) };
}

/** Restores what approvalSnapshot saved, dropping anything malformed. */
export function restoreApprovals(snapshot = {}) {
  return approvalSnapshot({ pendingApprovals: snapshot.pendingApprovals, approvalGrants: snapshot.approvalGrants });
}
