// Evidence ledger (roadmap 1.5).
//
// The runtime, not the model, records what each tool call showed: a check
// that ran and its exit code, a command or code cell that produced output, a
// page that was fetched, a search, a file that changed. Events come only from
// tool results, so a reply that says "all tests pass" adds nothing here.
// Verification contracts (src/verification-contracts.mjs) read these events to
// decide whether a claim is supported.
//
// Every event gets a sequence number, a time and a digest (SHA-256 of the tool
// result, first 16 hex characters), so a later reader can tell which result
// an event stood for without storing the result itself. An edit starts a new
// code epoch; a check from an earlier epoch is stale.

import { createHash } from 'node:crypto';

export const EVIDENCE_KINDS = Object.freeze(['check', 'command', 'execution', 'fetch', 'search', 'edit', 'side_effect', 'tamper']);
const MAX_EVENTS = 2000;
const MAX_NUMBERS_PER_EVENT = 400;
const MAX_URLS_PER_EVENT = 50;

export function createEvidenceLedger() {
  return { events: [], seq: 0, epoch: 0 };
}

export function sessionEvidence(session) {
  if (!session || typeof session !== 'object') return null;
  if (!session.evidenceLedger || !Array.isArray(session.evidenceLedger.events)) session.evidenceLedger = createEvidenceLedger();
  return session.evidenceLedger;
}

export function digestOf(value) {
  let text;
  try { text = typeof value === 'string' ? value : JSON.stringify(value); } catch { text = String(value); }
  return createHash('sha256').update(String(text ?? '')).digest('hex').slice(0, 16);
}

// Numbers as they appear in output: 1,234.5 -> "1234.5", 12% -> "12".
export function numbersIn(text, limit = MAX_NUMBERS_PER_EVENT) {
  const out = new Set();
  for (const match of String(text || '').matchAll(/(?<![\w.])-?\d[\d,]*(?:\.\d+)?(?:e[+-]?\d+)?/gi)) {
    const value = normalizeNumber(match[0]);
    if (value !== null) out.add(value);
    if (out.size >= limit) break;
  }
  return [...out];
}

export function normalizeNumber(raw) {
  const cleaned = String(raw).replace(/,/g, '');
  const value = Number(cleaned);
  return Number.isFinite(value) ? String(value) : null;
}

export function normalizeUrl(raw) {
  try {
    const url = new URL(String(raw).trim().replace(/[).,;:'"\]]+$/, ''));
    if (!/^https?:$/.test(url.protocol)) return null;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^utm_|^(?:ref|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
    url.hostname = url.hostname.toLowerCase().replace(/^www\./, '');
    let text = url.toString();
    if (text.endsWith('/') && url.pathname !== '/') text = text.slice(0, -1);
    if (url.pathname === '/' && !url.search) text = text.replace(/\/$/, '');
    return text;
  } catch { return null; }
}

function outputText(result) {
  if (!result || typeof result !== 'object') return String(result ?? '');
  const parts = [];
  for (const key of ['stdout', 'stderr', 'output', 'content', 'text', 'result']) {
    const value = result[key];
    if (typeof value === 'string') parts.push(value);
    else if (value !== undefined && value !== null && key === 'result') { try { parts.push(JSON.stringify(value)); } catch {} }
  }
  return parts.join('\n');
}

/** Appends an event and returns it (with seq, at, epoch). */
export function recordEvidence(ledger, event) {
  if (!ledger || !event || !EVIDENCE_KINDS.includes(event.kind)) return null;
  if (event.kind === 'edit') ledger.epoch += 1;
  const entry = { seq: ++ledger.seq, at: Date.now(), epoch: ledger.epoch, ...event };
  ledger.events.push(entry);
  if (ledger.events.length > MAX_EVENTS) ledger.events.splice(0, ledger.events.length - MAX_EVENTS);
  return entry;
}

const EXECUTION_COMMAND = /^(?:python3?|py|Rscript|julia|node|deno|bun|ruby|perl|sqlite3|duckdb|jupyter|papermill)(?:\s|$)/i;

/**
 * Builds the event for one tool result, or null when it shows nothing worth
 * recording (a read, a denied call). `context` carries what the agent loop
 * already worked out: whether a command is a check (`isCheck`, `checkKind`)
 * and whether its exit status was hidden by a pipe (`masked`).
 */
// The research pack's MCP tools (plugins/oasis-research) fetch and search
// like the built-in tools; their result is { isError, content: text }.
const PACK_FETCH = /^mcp__.+__oasis_fetch_url$/;
const PACK_SEARCH = /^mcp__.+__oasis_web_search$/;

function packJson(result) {
  const text = typeof result.content === 'string' ? result.content : '';
  try { return JSON.parse(text); } catch { return null; }
}

function packEvidence(name, args, result, digest) {
  if (result.isError) return null;
  const text = typeof result.content === 'string' ? result.content : '';
  const data = packJson(result);
  if (PACK_FETCH.test(name)) {
    if (data && (typeof data.error === 'string' || (Number.isInteger(data.status) && (data.status < 200 || data.status >= 300)))) return null;
    const url = normalizeUrl((data && data.url) || args.url);
    return url ? { kind: 'fetch', tool: name, url, numbers: numbersIn(text), digest } : null;
  }
  // A clipped result is not valid JSON: read the "url" fields from the text.
  const urls = (data && Array.isArray(data.results) ? data.results.map((item) => item && item.url) : [...text.matchAll(/"url"\s*:\s*"([^"]+)"/g)].map((match) => match[1]))
    .map((url) => normalizeUrl(url)).filter(Boolean).slice(0, MAX_URLS_PER_EVENT);
  return { kind: 'search', tool: name, query: String(args.query || '').slice(0, 200), urls, digest };
}

// A test run that exits 0 having run nothing: `npm test -- --grep nomatch`,
// `node --test` on an empty glob, jest with --passWithNoTests. Each runner's
// own summary line, so ordinary output that mentions tests does not match.
function ranNoTests(text) {
  const value = String(text || '');
  if (/^\s*(?:#|ℹ)\s*tests 0\s*$/m.test(value) && !/^\s*(?:#|ℹ)\s*tests [1-9]/m.test(value)) return true;
  // Every test skipped (node:test, TAP, pytest, Jest): nothing was checked.
  if (/^\s*(?:#|ℹ)\s*pass 0\s*$/m.test(value) && /^\s*(?:#|ℹ)\s*(?:skipped|todo) [1-9]/m.test(value) && !/^\s*(?:#|ℹ)\s*pass [1-9]/m.test(value)) return true;
  if (/^=+ (?:\d+ (?:skipped|deselected|xfailed)(?:, )?)+ in [\d.]+s/m.test(value)) return true;
  if (/^\s*Tests:\s+\d+ skipped, \d+ total/m.test(value)) return true;
  if (/^\s*0 passing\b/m.test(value) && !/^\s*[1-9]\d* (?:passing|failing)\b/m.test(value)) return true;
  if (/\bNo tests found\b|\bno tests ran\b|\bNo test files found\b|^\s*Tests:\s+0 total/im.test(value)) return true;
  const cargo = [...value.matchAll(/^running (\d+) tests?$/gm)];
  if (cargo.length && cargo.every((match) => match[1] === '0')) return true;
  const go = value.split('\n').filter((line) => /^ok\s/.test(line));
  if (go.length && go.every((line) => /\[no tests to run\]/.test(line))) return true;
  return false;
}

// Selecting tests by name or file: fine while iterating, but a goal about the
// whole suite ("npm test passes") needs a run without it.
const TEST_FILTER = /(?:^|\s)(?:--grep|-g|--fgrep|-t|--testNamePattern|--test-name-pattern|--test-only|-k|--filter|--only|-run|--match|--test-skip-pattern|--deselect|--ignore|--ignore-glob|--testPathIgnorePatterns|--skip|--exclude|--exact)(?:[=\s]|$)/;
// The same filters set through the environment: PYTEST_ADDOPTS="-k fast",
// GOFLAGS=-run=TestX, NODE_OPTIONS=--test-name-pattern=x.
const ENV_FILTER_VAR = /\b(?:PYTEST_ADDOPTS|GOFLAGS|NODE_OPTIONS|JEST_\w+|MOCHA_\w+|VITEST_\w+|CARGO_\w+|NODE_TEST_\w+)=("[^"]*"|'[^']*'|\S+)/g;
const ENV_FILTER_FLAG = /(?:^|\s)(?:-k|-m|-run|--run|--grep|-g|--test-name-pattern|--test-skip-pattern|--test-only|--testNamePattern|-t|--deselect|--skip)(?:[=\s]|$)/;
const envFiltered = (text) => [...text.matchAll(ENV_FILTER_VAR)].some((match) => ENV_FILTER_FLAG.test(match[1].replace(/^["']|["']$/g, '')));

function filteredRun(command) {
  const text = String(command || '');
  const split = text.indexOf(' -- ');
  const tail = split >= 0 ? text.slice(split + 4) : text.replace(/^\S+/, '');
  return TEST_FILTER.test(' ' + tail) || envFiltered(text);
}

export function evidenceFromToolResult(name, args = {}, result = {}, context = {}) {
  if (!result || typeof result !== 'object') return null;
  if (PACK_FETCH.test(name) || PACK_SEARCH.test(name)) return packEvidence(name, args || {}, result, digestOf(result));
  if (result.approved === false) return null;
  const digest = digestOf(result);
  if (name === 'run_command' || name === 'run_shell') {
    const command = name === 'run_shell' ? String(args.command || '') : [args.command].concat(Array.isArray(args.args) ? args.args : []).filter(Boolean).join(' ');
    const exitCode = Number.isInteger(result.exitCode) ? result.exitCode : null;
    const finished = exitCode !== null && !result.timedOut && !result.cancelled;
    if (context.isCheck) {
      const noTests = finished && exitCode === 0 && ranNoTests(outputText(result));
      const filtered = (context.checkKind || 'test') === 'test' && filteredRun(command);
      return { kind: 'check', tool: name, command: command.slice(0, 300), checkKind: context.checkKind || 'test', exitCode, masked: Boolean(context.masked), finished, passed: finished && !context.masked ? exitCode === 0 : null, ...(noTests ? { noTests: true } : {}), ...(filtered ? { filtered: true } : {}), digest };
    }
    const text = outputText(result);
    const execution = EXECUTION_COMMAND.test(command.trim());
    return { kind: execution ? 'execution' : 'command', tool: name, command: command.slice(0, 300), exitCode, finished, numbers: finished ? numbersIn(text) : [], digest };
  }
  if (name === 'execute_code') {
    const failed = typeof result.error === 'string';
    return { kind: 'execution', tool: name, exitCode: failed ? 1 : 0, finished: true, numbers: failed ? [] : numbersIn(outputText(result) + '\n' + (Array.isArray(result.logs) ? result.logs.join('\n') : '')), digest };
  }
  if (name === 'fetch_url') {
    if (typeof result.error === 'string' || (Number.isInteger(result.status) && (result.status < 200 || result.status >= 300))) return null;
    const url = normalizeUrl(result.url || args.url);
    if (!url) return null;
    const finalUrl = result.finalUrl ? normalizeUrl(result.finalUrl) : null;
    return { kind: 'fetch', tool: name, url, ...(finalUrl && finalUrl !== url ? { finalUrl } : {}), numbers: numbersIn(outputText(result)), digest };
  }
  if (name === 'browser') {
    const url = normalizeUrl(result.url || (args && args.url));
    if (!url || typeof result.error === 'string') return null;
    return { kind: 'fetch', tool: name, url, numbers: numbersIn(outputText(result)), digest };
  }
  if (name === 'web_search') {
    const urls = (Array.isArray(result.results) ? result.results : []).map((item) => normalizeUrl(item && item.url)).filter(Boolean).slice(0, MAX_URLS_PER_EVENT);
    return { kind: 'search', tool: name, query: String(args.query || '').slice(0, 200), urls, digest };
  }
  if (context.edited && context.path) {
    return { kind: 'edit', tool: name, path: String(context.path).slice(0, 400), digest };
  }
  if (['install_package', 'install_plugin', 'install_extension', 'install_external_skill', 'configure_provider', 'configure_mcp_server', 'add_extension', 'git_commit', 'git_branch', 'worktree_merge'].includes(name) && typeof result.error !== 'string') {
    return { kind: 'side_effect', tool: name, digest };
  }
  return null;
}

/** Events from `fromSeq` on (exclusive), e.g. one turn or one child run. */
export function evidenceSince(ledger, fromSeq = 0) {
  if (!ledger) return [];
  return ledger.events.filter((event) => event.seq > fromSeq);
}

/** The latest check in `events`, with `stale: true` when an edit came after it. */
export function lastCheck(events) {
  let check = null;
  let editedAfter = false;
  for (const event of events || []) {
    if (event.kind === 'check') { check = event; editedAfter = false; }
    else if (event.kind === 'edit' && check) editedAfter = true;
  }
  return check ? { ...check, stale: editedAfter } : null;
}

export function fetchedUrls(events) {
  const out = new Set();
  for (const event of events || []) if (event.kind === 'fetch') { out.add(event.url); if (event.finalUrl) out.add(event.finalUrl); }
  return out;
}

export function searchedUrls(events) {
  const out = new Set();
  for (const event of events || []) if (event.kind === 'search') for (const url of event.urls || []) out.add(url);
  return out;
}

/** Numbers that a finished execution, command or fetched page printed. */
export function producedNumbers(events, { kinds = ['execution', 'command', 'check', 'fetch'] } = {}) {
  const out = new Set();
  for (const event of events || []) if (kinds.includes(event.kind)) for (const value of event.numbers || []) out.add(value);
  return out;
}

/** A compact, JSON-safe view for results and logs. */
export function evidenceSummary(events) {
  const counts = {};
  for (const event of events || []) counts[event.kind] = (counts[event.kind] || 0) + 1;
  const check = lastCheck(events);
  return {
    events: (events || []).length,
    counts,
    ...(check ? { lastCheck: { command: check.command, exitCode: check.exitCode, passed: check.passed, stale: check.stale, digest: check.digest } } : {}),
    range: events && events.length ? { from: events[0].seq, to: events[events.length - 1].seq } : null
  };
}
