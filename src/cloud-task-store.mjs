// Durable task metadata and event history for the Oasis browser runtime.
//
// This is a local persistence layer, not a hosted cloud scheduler. It deliberately
// stores task state under the user's private Oasis config directory, never in the
// project checkout, and uses restrictive permissions plus atomic replacement.
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

const TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TERMINAL = new Set(['completed', 'cancelled', 'error', 'interrupted']);
const STATUSES = new Set(['running', 'waiting_approval', ...TERMINAL]);
const DEFAULT_MAX_TASKS = 200;
const DEFAULT_MAX_EVENTS = 120;
const MAX_RECORD_BYTES = 1_000_000;
const SECRET_KEY = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization|credential|private[_-]?key)/i;

function scrubText(value, limit = 4000) {
  return String(value)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED]')
    .replace(/(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|authorization)\b\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, '$1[REDACTED]')
    .slice(0, limit);
}

function safeValue(value, key = '', depth = 0) {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return scrubText(value);
  if (depth >= 6) return '[depth limited]';
  if (Array.isArray(value)) return value.slice(0, 30).map((item) => safeValue(item, '', depth + 1));
  if (typeof value !== 'object') return scrubText(value);
  const out = {};
  for (const [childKey, childValue] of Object.entries(value).slice(0, 40)) {
    out[String(childKey).slice(0, 100)] = safeValue(childValue, childKey, depth + 1);
  }
  return out;
}

function statusOf(value) {
  return STATUSES.has(value) ? value : 'error';
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function makeSnapshot(job, maxEvents) {
  if (!job || typeof job !== 'object' || !TASK_ID.test(String(job.id || ''))) {
    throw new Error('Cloud task needs a valid UUID.');
  }
  const now = new Date().toISOString();
  const events = Array.isArray(job.events) ? job.events.slice(-maxEvents).map((event, index) => ({
    id: Number.isSafeInteger(event && event.id) && event.id > 0 ? event.id : index + 1,
    type: scrubText(event && event.type || 'event', 100),
    at: scrubText(event && event.at || now, 40),
    data: safeValue(event && event.data || {})
  })) : [];
  return {
    schemaVersion: 1,
    id: job.id,
    type: scrubText(job.type || 'agent', 40),
    title: scrubText(job.title || job.type || 'Coding task', 160),
    status: statusOf(job.status),
    createdAt: scrubText(job.createdAt || now, 40),
    updatedAt: now,
    sessionId: /^[a-f0-9-]{20,80}$/i.test(String(job.sessionId || '')) ? String(job.sessionId) : null,
    workspaceName: scrubText(job.workspaceName || '', 160),
    result: job.result == null ? null : safeValue(job.result),
    error: job.error == null ? null : scrubText(job.error, 4000),
    events,
    nextEventId: Math.max(Number(job.nextEventId) || 1, ...events.map((event) => event.id + 1), 1)
  };
}

function validateStored(raw, id, maxEvents) {
  if (!raw || raw.schemaVersion !== 1 || raw.id !== id || !TASK_ID.test(id)) return null;
  if (!Array.isArray(raw.events) || raw.events.length > maxEvents || !STATUSES.has(raw.status)) return null;
  const snapshot = makeSnapshot({
    ...raw,
    id,
    events: raw.events,
    result: raw.result,
    error: raw.error
  }, maxEvents);
  snapshot.createdAt = scrubText(raw.createdAt || snapshot.createdAt, 40);
  snapshot.updatedAt = scrubText(raw.updatedAt || snapshot.updatedAt, 40);
  snapshot.status = statusOf(raw.status);
  snapshot.nextEventId = Math.max(Number(raw.nextEventId) || 1, ...snapshot.events.map((event) => event.id + 1), 1);
  return snapshot;
}

export function createCloudTaskStore(root, options = {}) {
  const env = options.env || process.env;
  const maxTasks = Math.max(10, Math.min(1000, Number(options.maxTasks) || DEFAULT_MAX_TASKS));
  const maxEvents = Math.max(20, Math.min(500, Number(options.maxEvents) || DEFAULT_MAX_EVENTS));
  const workspaceHash = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24);
  const directory = path.join(getConfigDirectory(env), 'cloud-tasks', workspaceHash);
  const records = new Map();
  const writeQueues = new Map();
  const timers = new Map();
  let readyPromise = null;

  function recordPath(id) {
    if (!TASK_ID.test(String(id || ''))) throw new Error('Invalid task ID.');
    return path.join(directory, id + '.json');
  }

  async function writeRecord(record) {
    let safe = clone(record);
    let body = JSON.stringify(safe, null, 2) + '\n';
    if (Buffer.byteLength(body, 'utf8') > MAX_RECORD_BYTES) {
      safe.events = safe.events.slice(-40);
      safe.result = safe.result == null ? null : { note: 'Task result omitted from local history because it exceeded the persistence size limit.' };
      body = JSON.stringify(safe, null, 2) + '\n';
    }
    if (Buffer.byteLength(body, 'utf8') > MAX_RECORD_BYTES) throw new Error('Cloud task record exceeds the safe persistence size limit.');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    try { await chmod(directory, 0o700); } catch {}
    const destination = recordPath(safe.id);
    const temporary = destination + '.' + randomUUID() + '.tmp';
    await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    try {
      await rename(temporary, destination);
      try { await chmod(destination, 0o600); } catch {}
    } catch (error) {
      try { await unlink(temporary); } catch {}
      throw error;
    }
  }

  async function prune() {
    if (records.size <= maxTasks) return;
    const removable = [...records.values()]
      .filter((record) => TERMINAL.has(record.status))
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    while (records.size > maxTasks && removable.length) {
      const record = removable.shift();
      records.delete(record.id);
      try { await unlink(recordPath(record.id)); } catch {}
    }
  }

  async function ensureLoaded() {
    if (!readyPromise) {
      readyPromise = (async () => {
        await mkdir(directory, { recursive: true, mode: 0o700 });
        try { await chmod(directory, 0o700); } catch {}
        const names = (await readdir(directory)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).slice(0, maxTasks * 5);
        for (const name of names) {
          const id = name.slice(0, -5);
          try {
            const source = await readFile(recordPath(id), 'utf8');
            if (Buffer.byteLength(source, 'utf8') > MAX_RECORD_BYTES) continue;
            const record = validateStored(JSON.parse(source), id, maxEvents);
            if (!record) continue;
            if (!TERMINAL.has(record.status)) {
              record.status = 'interrupted';
              record.error = 'The Oasis runtime restarted before this task finished. Review its saved events and resume from the associated session if appropriate.';
              record.updatedAt = new Date().toISOString();
              record.events.push({
                id: record.nextEventId++,
                type: 'interrupted',
                at: record.updatedAt,
                data: { message: 'Runtime stopped before task completion; live processes and pending approvals were not restored.' }
              });
              record.events = record.events.slice(-maxEvents);
              await writeRecord(record);
            }
            records.set(id, record);
          } catch {
            // A corrupt history record must not prevent the runtime from starting.
          }
        }
        await prune();
      })().catch((error) => {
        readyPromise = null;
        throw error;
      });
    }
    return await readyPromise;
  }

  async function save(job) {
    const snapshot = makeSnapshot(job, maxEvents);
    await ensureLoaded();
    const id = snapshot.id;
    const previous = writeQueues.get(id) || Promise.resolve();
    const operation = previous.catch(() => {}).then(async () => {
      records.set(id, snapshot);
      await writeRecord(snapshot);
      await prune();
      return clone(snapshot);
    });
    writeQueues.set(id, operation);
    try {
      return await operation;
    } finally {
      if (writeQueues.get(id) === operation) writeQueues.delete(id);
    }
  }

  function schedule(job, delayMs) {
    const id = String(job && job.id || '');
    if (!TASK_ID.test(id)) return;
    const previous = timers.get(id);
    if (previous) clearTimeout(previous);
    const delay = TERMINAL.has(job.status) ? 0 : Math.max(0, Math.min(2000, Number(delayMs) || 200));
    const timer = setTimeout(() => {
      timers.delete(id);
      void save(job).catch(() => {});
    }, delay);
    timer.unref?.();
    timers.set(id, timer);
  }

  async function get(id) {
    if (!TASK_ID.test(String(id || ''))) return null;
    await ensureLoaded();
    const queued = writeQueues.get(id);
    if (queued) await queued.catch(() => {});
    const record = records.get(id);
    return record ? clone(record) : null;
  }

  async function list(options = {}) {
    await ensureLoaded();
    await Promise.all([...writeQueues.values()].map((queue) => queue.catch(() => {})));
    const limit = Math.max(1, Math.min(100, Number(options.limit) || 50));
    return [...records.values()]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, limit)
      .map((record) => ({
        id: record.id,
        type: record.type,
        title: record.title,
        status: record.status,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        sessionId: record.sessionId,
        workspaceName: record.workspaceName,
        eventCount: record.events.length,
        error: record.error
      }));
  }

  async function flush(jobs = []) {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
    await Promise.all(jobs.map((job) => save(job).catch(() => null)));
    await Promise.all([...writeQueues.values()].map((queue) => queue.catch(() => {})));
  }

  return {
    directory,
    save,
    schedule,
    get,
    list,
    flush,
    async ready() { await ensureLoaded(); }
  };
}
