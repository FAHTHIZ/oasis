// Oasis Neuron Network ledger: an append-only record of every neuron's state
// transitions and budget charges, kept in node:sqlite next to the session index
// (<config>/sessions/neuron-ledger.sqlite).
//
// The in-memory agent registry stays the live source of truth. The ledger is
// what survives a crash: session files are only saved between turns, so a
// process killed mid-turn would otherwise forget the workers it had started.
// On restore, any neuron whose last recorded state is "running" comes back as
// "interrupted", never as running.
//
// Ledger writes are best-effort. A missing node:sqlite, a read-only disk or a
// locked file turns the ledger off for that session; orchestration never fails
// because of it. OASIS_NEURON_LEDGER=0 turns it off.

import { createRequire } from 'node:module';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { getConfigDirectory } from './config.mjs';

export const LEDGER_SCHEMA_VERSION = 1;
const TERMINAL = new Set(['completed', 'failed', 'cancelled', 'stalled', 'interrupted']);
const STATUSES = new Set(['running', ...TERMINAL]);
const KINDS = new Set(['spawn', 'transition', 'charge']);
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE IF NOT EXISTS neuron_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    neuron_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('spawn', 'transition', 'charge')),
    parent_id TEXT,
    depth INTEGER,
    role TEXT,
    description TEXT,
    team_id TEXT,
    status TEXT,
    tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0,
    requests INTEGER NOT NULL DEFAULT 0,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS neuron_events_session ON neuron_events (session_id, seq);
  CREATE TRIGGER IF NOT EXISTS neuron_events_append_only BEFORE UPDATE ON neuron_events
  BEGIN SELECT RAISE(ABORT, 'the neuron ledger is append-only'); END;
`;

let sqlite;
function loadSqlite() {
  if (sqlite !== undefined) return sqlite;
  const original = process.emitWarning;
  process.emitWarning = function (warning, ...rest) {
    if (/SQLite is an experimental feature/.test(String(warning && warning.message ? warning.message : warning))) return;
    return original.call(this, warning, ...rest);
  };
  try { sqlite = createRequire(import.meta.url)('node:sqlite'); } catch { sqlite = null; } finally { process.emitWarning = original; }
  return sqlite;
}

function text(value, max) {
  if (value === undefined || value === null || value === '') return null;
  return String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, max);
}

function count(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

/** Open (or create) a ledger file. Returns null when node:sqlite is unavailable. */
export function openNeuronLedger(file) {
  const lib = loadSqlite();
  if (!lib) return null;
  mkdirSync(path.dirname(file), { recursive: true });
  const db = new lib.DatabaseSync(file);
  try {
    db.exec('PRAGMA busy_timeout = 2000');
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec(SCHEMA);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('version', ?)").run(String(LEDGER_SCHEMA_VERSION));
  } catch (error) { db.close(); throw error; }
  try { chmodSync(file, 0o600); } catch {}
  const insert = db.prepare(`INSERT INTO neuron_events
    (session_id, neuron_id, kind, parent_id, depth, role, description, team_id, status, tokens, cost_usd, requests, at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  insert.setReadBigInts(true);
  const select = db.prepare('SELECT * FROM neuron_events WHERE session_id = ? ORDER BY seq');
  let open = true;
  return {
    file,
    append(sessionId, row) {
      if (!open) return false;
      const kind = KINDS.has(row.kind) ? row.kind : null;
      const neuron = text(row.neuronId, 100);
      if (!kind || !neuron || !sessionId) return false;
      const status = row.status && STATUSES.has(row.status) ? row.status : null;
      insert.run(String(sessionId).slice(0, 200), neuron, kind, text(row.parentId, 100), row.depth == null ? null : count(row.depth),
        text(row.role, 80), text(row.description, 200), text(row.teamId, 100), status,
        count(row.tokens), money(row.costUsd), count(row.requests), Number.isFinite(row.at) ? Math.floor(row.at) : Date.now());
      return true;
    },
    rows(sessionId) {
      if (!open) return [];
      return select.all(String(sessionId).slice(0, 200));
    },
    /**
     * Rows of the sessions active since `since` (newest sessions first, at most
     * `maxSessions`), across every process that writes this file: the terminal,
     * the web app, gateways and A2A. For the control room.
     */
    recent(since = 0, maxSessions = 40) {
      if (!open) return [];
      const ids = db.prepare('SELECT session_id, MAX(at) AS last FROM neuron_events GROUP BY session_id HAVING MAX(at) >= ? ORDER BY last DESC LIMIT ?')
        .all(Math.floor(Number(since) || 0), Math.max(1, Math.min(500, Math.floor(Number(maxSessions) || 40))));
      return ids.map(({ session_id: id }) => ({ sessionId: id, rows: select.all(id) }));
    },
    /** Drop whole sessions older than the retention window. Rows are never edited. */
    prune(now = Date.now(), retentionMs = RETENTION_MS) {
      if (!open) return 0;
      const cutoff = now - retentionMs;
      const stale = db.prepare('SELECT session_id FROM neuron_events GROUP BY session_id HAVING MAX(at) < ?').all(cutoff);
      const drop = db.prepare('DELETE FROM neuron_events WHERE session_id = ?');
      for (const { session_id: id } of stale) drop.run(id);
      return stale.length;
    },
    close() { if (open) { open = false; db.close(); } }
  };
}

/**
 * Fold ledger rows into neuron states. Pure, so any prefix of a ledger (the
 * state after a crash at that write) can be replayed. With `recover`, neurons
 * still marked running become interrupted: their processes did not survive.
 */
export function reduceNeuronLedger(rows, { recover = false } = {}) {
  const neurons = new Map();
  for (const row of rows || []) {
    const id = row.neuron_id;
    if (!id) continue;
    if (row.kind === 'spawn') {
      if (neurons.has(id)) continue;
      neurons.set(id, {
        id,
        parentId: row.parent_id || 'main',
        depth: Math.max(1, Number(row.depth) || 1),
        role: row.role || 'general-purpose',
        description: row.description || '',
        teamId: row.team_id || null,
        status: 'running',
        startedAt: Number(row.at) || 0,
        finishedAt: null,
        tokens: 0,
        costUsd: 0,
        requests: 0,
        transitions: 1,
        lastAt: Number(row.at) || 0
      });
      continue;
    }
    const neuron = neurons.get(id);
    if (!neuron) continue;
    neuron.lastAt = Math.max(neuron.lastAt || 0, Number(row.at) || 0);
    if (row.kind === 'transition' && STATUSES.has(row.status)) {
      neuron.status = row.status;
      neuron.finishedAt = TERMINAL.has(row.status) ? Number(row.at) || null : null;
      neuron.transitions += 1;
    } else if (row.kind === 'charge') {
      neuron.tokens += count(row.tokens);
      neuron.costUsd += money(row.cost_usd);
      neuron.requests += count(row.requests);
    }
  }
  if (recover) {
    for (const neuron of neurons.values()) {
      if (neuron.status === 'running') { neuron.status = 'interrupted'; neuron.recovered = true; }
    }
  }
  return neurons;
}

// Ledgers and record bindings live outside the session and record objects so
// they are never serialized into a saved session.
const ledgers = new Map();
const sessionLedger = new WeakMap();
const recordSession = new WeakMap();

export function neuronLedgerFile(env = process.env) {
  if (env.OASIS_NEURON_LEDGER_FILE) return path.resolve(env.OASIS_NEURON_LEDGER_FILE);
  return path.join(getConfigDirectory(env), 'sessions', 'neuron-ledger.sqlite');
}

function ledgerEnabled(env) {
  return !['0', 'false', 'off', 'no'].includes(String(env.OASIS_NEURON_LEDGER || '').toLowerCase());
}

function ledgerFor(session) {
  if (!session || !session.sessionId) return null;
  if (sessionLedger.has(session)) return sessionLedger.get(session);
  // Subagent sessions share the root's session id; they also use its environment.
  let root = session;
  for (let hops = 0; hops < 40 && !root.createEnv && root.parentSessionRef; hops++) root = root.parentSessionRef;
  const env = root.createEnv || process.env;
  let ledger = null;
  if (ledgerEnabled(env)) {
    const file = neuronLedgerFile(env);
    ledger = ledgers.get(file) || null;
    if (!ledger) {
      try {
        ledger = openNeuronLedger(file);
        if (ledger) {
          ledgers.set(file, ledger);
          try { ledger.prune(); } catch {}
        }
      } catch { ledger = null; }
    }
  }
  sessionLedger.set(session, ledger);
  return ledger;
}

function append(session, row) {
  const ledger = ledgerFor(session);
  if (!ledger) return false;
  try { return ledger.append(session.sessionId, row); } catch { sessionLedger.set(session, null); return false; }
}

/** A new neuron: written when the registry assigns its id. */
export function ledgerSpawn(session, record) {
  if (!record) return false;
  recordSession.set(record, session);
  return append(session, {
    kind: 'spawn', neuronId: record.id, parentId: record.parentId || 'main', depth: record.depth,
    role: record.type, description: record.description, teamId: record.teamId, at: Number(record.startedAt) || Date.now()
  });
}

/** A state change, using the status the record holds now. */
export function ledgerTransition(session, record) {
  if (!record || !STATUSES.has(record.status)) return false;
  recordSession.set(record, session);
  return append(session, { kind: 'transition', neuronId: record.id, status: record.status });
}

/** A budget charge from one model request (or a usage phase of one). */
export function ledgerCharge(record, usage) {
  const session = record && recordSession.get(record);
  if (!session || !usage) return false;
  return append(session, {
    kind: 'charge', neuronId: record.id, tokens: usage.totalTokens, costUsd: usage.costUsd,
    requests: usage.phase === undefined ? 1 : 0
  });
}

const LIFECYCLE_EVENTS = new Set([
  'agent.background_started', 'agent.resumed', 'agent.completed', 'agent.failed',
  'agent.cancelled', 'agent.stalled', 'agent.interrupted'
]);

/** Called from recordAgentEvent: lifecycle events become ledger transitions. */
export function ledgerAgentEvent(session, type, record) {
  if (!record) return false;
  if (type === 'agent.started') return ledgerSpawn(session, record);
  if (LIFECYCLE_EVENTS.has(type)) return ledgerTransition(session, record);
  return false;
}

/**
 * Neurons the ledger knows for this session that the restored registry does
 * not (the process died before the session file was saved). Each comes back
 * interrupted, with the budget it had already spent.
 */
export function recoverLedgerNeurons(session, knownIds = new Set()) {
  const ledger = ledgerFor(session);
  if (!ledger) return [];
  let rows;
  try { rows = ledger.rows(session.sessionId); } catch { return []; }
  const recovered = [];
  for (const neuron of reduceNeuronLedger(rows, { recover: true }).values()) {
    if (knownIds.has(neuron.id)) continue;
    recovered.push(neuron);
  }
  return recovered;
}

/**
 * The shared ledger file for this environment, opened once per process and
 * reused (the same handle sessions write through). Null when it is off or
 * node:sqlite is missing.
 */
export function sharedNeuronLedger(env = process.env) {
  if (!ledgerEnabled(env)) return null;
  const file = neuronLedgerFile(env);
  if (ledgers.has(file)) return ledgers.get(file);
  try {
    const ledger = openNeuronLedger(file);
    if (ledger) ledgers.set(file, ledger);
    return ledger;
  } catch { return null; }
}

/** For tests: close every open ledger and forget session bindings. */
export function closeNeuronLedgers() {
  for (const ledger of ledgers.values()) { try { ledger.close(); } catch {} }
  ledgers.clear();
}
