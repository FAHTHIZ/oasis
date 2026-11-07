// Append-only event stream for OASIS agent sessions.
//
// Records tool calls, tool results, approvals, recoveries, and verification
// outcomes as sequence-numbered JSONL events. Secrets are redacted with the
// same patterns as auto memory. The log lives next to the session file so a
// crash or restart never loses the audit trail.
import { appendFile, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { getSessionDirectory } from './sessions.mjs';
import { redactSecrets } from './auto-memory.mjs';

const EVENT_TYPES = new Set(['tool_call', 'tool_result', 'approval', 'recovery', 'verification', 'session_saved']);

const eventQueues = new Map();

// Sequence allocation and append must be one operation. Parallel tool calls
// used to read the same line count and write duplicate sequence numbers.
async function withEventLock(file, work) {
  const previous = eventQueues.get(file) || Promise.resolve();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const tail = previous.then(() => gate);
  eventQueues.set(file, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (eventQueues.get(file) === tail) eventQueues.delete(file);
  }
}

export function eventLogPath(root, sessionId, env = process.env) {
  if (typeof sessionId !== 'string' || !/^[a-f0-9-]{20,80}$/i.test(sessionId)) throw new Error('Invalid session ID.');
  return path.join(getSessionDirectory(root, env), sessionId + '.events.jsonl');
}

function redactEvent(event) {
  const clone = { ...event };
  for (const key of Object.keys(clone)) {
    if (typeof clone[key] === 'string') clone[key] = redactSecrets(clone[key]).text;
    else if (clone[key] && typeof clone[key] === 'object') clone[key] = JSON.parse(redactSecrets(JSON.stringify(clone[key])).text);
  }
  return clone;
}

// Append one event. Sequence numbers are derived from the current line count,
// so a crash mid-write cannot create gaps or duplicates.
export async function appendEvent(root, sessionId, event, options = {}) {
  const env = options.env || process.env;
  const type = String(event && event.type || '');
  if (!EVENT_TYPES.has(type)) throw new Error('Unknown event type: ' + type);
  const file = eventLogPath(root, sessionId, env);
  return await withEventLock(file, async () => {
    let seq = 0;
    try {
      const existing = await readFile(file, 'utf8');
      seq = existing.split('\n').filter(Boolean).length;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    const record = redactEvent({ ...event, seq, at: new Date().toISOString(), type });
    await appendFile(file, JSON.stringify(record) + '\n', { encoding: 'utf8', mode: 0o600 });
    return record;
  });
}

// Read the full event log, oldest first.
export async function readEvents(root, sessionId, options = {}) {
  const env = options.env || process.env;
  const file = eventLogPath(root, sessionId, env);
  return await withEventLock(file, async () => {
    let text;
    try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return text.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  });
}

// Remove the event log (used when a session is deleted).
export async function clearEvents(root, sessionId, options = {}) {
  const env = options.env || process.env;
  const file = eventLogPath(root, sessionId, env);
  try { await unlink(file); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { cleared: true };
}
