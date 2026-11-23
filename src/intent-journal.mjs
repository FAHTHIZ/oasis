// Intent journal: durable execution for consequential tool calls
// (docs/DURABLE-EXECUTION.md).
//
// A session is saved mid-turn at most every few seconds, so a crash can lose
// the record of a step that did run: the restored transcript either marks it
// "Interrupted: may have partly run" or, when the crash came before the next
// save, does not show the call at all. Either way the model is left to guess
// whether `git commit`, a migration or a deploy happened, and guessing wrong
// repeats it or skips it.
//
// The journal is a write-ahead log. Before a consequential call starts (after
// it was authorized) an `intent` record is appended and fsynced; when it
// returns, a `done` record. Each intent carries probes: small observations of
// the world taken before the call, with the state the call is expected to
// leave where that is known in advance:
//
//   file      the target file's SHA-256 (or absence) before, and for
//             write_file / delete_file the expected one after
//   paths     for a command, the hashes of the paths its command line names
//   git_head  HEAD before a commit, merge, reset or push
//
// After a restart, reconcileJournal() finds intents with no `done` (in
// doubt) and `done` records the saved transcript never got (unrecorded), then
// re-reads each probe and decides from the world, not from memory, whether
// the action took effect: applied, not_applied, changed (something else
// changed the target), or unknown (nothing to check, such as an API call).
// The agent is told exactly that before its next step, and the "Interrupted"
// placeholders in the restored transcript are replaced with it.
//
// The journal holds digests and short redacted summaries, never file
// contents or full arguments. OASIS_INTENT_JOURNAL=0 turns it off.

import { createHash, randomUUID } from 'node:crypto';
import { open, mkdir, readdir, readFile, lstat, rename, stat, unlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { getSessionDirectory } from './session-paths.mjs';
import { predictArgvEffects, predictShellEffects } from './effect-contracts.mjs';

export const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 2 * 1024 * 1024;
const MAX_PROBE_FILES = 20;
const MAX_HASH_BYTES = 32 * 1024 * 1024;
const JOURNAL_MAX_AGE_MS = 14 * 86_400_000;

export const JOURNALED_TOOLS = new Set([
  'run_command', 'run_shell', 'powershell',
  'write_file', 'edit_file', 'multi_edit', 'apply_patch', 'delete_file', 'notebook_edit',
  'install_package', 'install_plugin', 'install_extension', 'install_external_skill', 'add_extension',
  'configure_mcp_server', 'configure_provider', 'git_commit', 'create_pull_request', 'deploy', 'generate_image', 'text_to_speech'
]);

const FILE_TOOLS = new Set(['write_file', 'edit_file', 'multi_edit', 'delete_file', 'notebook_edit', 'generate_image', 'text_to_speech']);
const GIT_MOVING = /\bgit\s+(?:-[^\s]+\s+)*(?:commit|merge|rebase|reset|pull|cherry-pick|revert|am|push|checkout|switch)\b/;

export function intentJournalEnabled(env = process.env, settings = {}) {
  if (/^(0|false|off|no)$/i.test(String(env.OASIS_INTENT_JOURNAL ?? '').trim())) return false;
  return !(settings && settings.intentJournal === false);
}

export function journalPathFor(root, journalId, env = process.env) {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(String(journalId || ''))) throw new Error('Invalid journal id.');
  return path.join(getSessionDirectory(root, env), 'journal', journalId + '.jsonl');
}

export function sessionJournal(session, env = process.env) {
  if (!session || !session.root || !intentJournalEnabled(env, session.settings || {})) return null;
  if (!session.journalId) session.journalId = randomUUID();
  if (!session.journalPath) session.journalPath = journalPathFor(session.root, session.journalId, env);
  if (!Number.isInteger(session.journalSeq)) session.journalSeq = 0;
  return { path: session.journalPath, id: session.journalId };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) if (value[key] !== undefined) out[key] = canonical(value[key]);
    return out;
  }
  return value;
}

export function digest(value) {
  const text = typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value));
  return createHash('sha256').update(text ?? '').digest('hex');
}

// Same tool and same arguments: the same action. Used to tell a model that
// is about to redo an in-doubt action that it is the one in doubt.
export function idempotencyKey(tool, args) {
  return digest({ tool: String(tool), args: canonical(args || {}) }).slice(0, 32);
}

async function hashPath(absolute) {
  const info = await lstat(absolute).catch(() => null);
  if (!info) return null;
  if (info.isSymbolicLink()) return 'symlink';
  if (info.isDirectory()) return 'dir';
  if (!info.isFile()) return 'special';
  if (info.size > MAX_HASH_BYTES) return 'size:' + info.size + ':' + Math.floor(info.mtimeMs);
  return createHash('sha256').update(await readFile(absolute)).digest('hex');
}

function inside(root, relative) {
  const base = path.resolve(root);
  const absolute = path.resolve(base, String(relative || ''));
  return absolute === base || absolute.startsWith(base + path.sep) ? absolute : null;
}

function gitHead(root) {
  const result = spawnSync('git', ['rev-parse', '--verify', '-q', 'HEAD'], { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }, timeout: 5000 });
  return result.status === 0 ? result.stdout.trim() : null;
}

// Observations taken before the call, with expected outcomes where known.
export async function probesFor(root, tool, args = {}) {
  const probes = [];
  if (FILE_TOOLS.has(tool)) {
    const target = args.path || args.file_path || args.notebook_path || args.output_path;
    const absolute = target && inside(root, target);
    if (absolute) {
      const probe = { kind: 'file', path: path.relative(root, absolute).split(path.sep).join('/'), before: await hashPath(absolute) };
      if (tool === 'write_file' && typeof args.content === 'string') probe.expected = digest(args.content);
      if (tool === 'delete_file') probe.expected = null;
      probes.push(probe);
    }
  }
  if (tool === 'run_command' || tool === 'run_shell') {
    const predicted = tool === 'run_command' ? predictArgvEffects(args.command, args.args) : predictShellEffects(args.command);
    const cwd = typeof args.cwd === 'string' ? args.cwd : '';
    const files = [];
    for (const item of predicted.paths.slice(0, MAX_PROBE_FILES)) {
      const absolute = inside(root, path.join(cwd, String(item)));
      if (!absolute || /\/$/.test(item)) continue;
      files.push({ path: path.relative(root, absolute).split(path.sep).join('/'), before: await hashPath(absolute) });
    }
    if (files.length) probes.push({ kind: 'paths', files, broad: predicted.broad });
    const line = tool === 'run_command' ? [args.command, ...(args.args || [])].join(' ') : String(args.command || '');
    if (GIT_MOVING.test(line)) probes.push({ kind: 'git_head', before: gitHead(root) });
  }
  if (tool === 'git_commit') probes.push({ kind: 'git_head', before: gitHead(root) });
  return probes;
}

function summarize(tool, args = {}) {
  const pick = args.command !== undefined ? [args.command, ...(Array.isArray(args.args) ? args.args : [])].join(' ') : (args.path || args.file_path || args.name || args.package || args.title || '');
  return String(pick || '').replace(/\s+/g, ' ').slice(0, 200);
}

// Journals of sessions untouched for two weeks are removed when a new one
// starts; a session resumed after that resumes without reconciliation.
export async function pruneJournals(directory, now = Date.now()) {
  let removed = 0;
  for (const name of await readdir(directory).catch(() => [])) {
    if (!name.endsWith('.jsonl')) continue;
    const file = path.join(directory, name);
    const info = await stat(file).catch(() => null);
    if (info && now - info.mtimeMs > JOURNAL_MAX_AGE_MS) { await unlink(file).catch(() => {}); removed++; }
  }
  return removed;
}

async function appendDurably(file, record) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const info = await stat(file).catch(() => null);
  if (!info) await pruneJournals(path.dirname(file)).catch(() => 0);
  if (info && info.size > MAX_JOURNAL_BYTES) await compactJournal(file);
  const handle = await open(file, 'a', 0o600);
  try {
    await handle.write(JSON.stringify(record) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Keep the unresolved intents and the most recent records; drop the rest.
export async function compactJournal(file) {
  const records = await readJournal(file);
  const done = new Set(records.filter((record) => record.t === 'done').map((record) => record.call));
  const open_ = records.filter((record) => record.t === 'intent' && !done.has(record.call));
  const recent = records.slice(-400);
  const keep = [...new Map([...open_, ...recent].map((record) => [record.t + ':' + record.seq, record])).values()].sort((a, b) => a.seq - b.seq);
  const tmp = file + '.' + process.pid + '.tmp';
  const handle = await open(tmp, 'w', 0o600);
  try { await handle.write(keep.map((record) => JSON.stringify(record)).join('\n') + (keep.length ? '\n' : '')); await handle.sync(); } finally { await handle.close(); }
  await rename(tmp, file);
}

export async function readJournal(file) {
  let text = '';
  try { text = await readFile(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    // A torn last line (crash mid-write) is skipped, not fatal.
    try { const record = JSON.parse(line); if (record && record.v === JOURNAL_VERSION && (record.t === 'intent' || record.t === 'done')) out.push(record); } catch {}
  }
  return out;
}

// Before a journaled call runs. Returns the intent (or null when off).
export async function journalIntent(session, { tool, args = {}, callId, env = process.env } = {}) {
  if (!JOURNALED_TOOLS.has(tool) && !String(tool).startsWith('mcp__')) return null;
  const journal = sessionJournal(session, env);
  if (!journal) return null;
  const record = {
    v: JOURNAL_VERSION,
    t: 'intent',
    seq: ++session.journalSeq,
    call: String(callId || ''),
    tool,
    key: idempotencyKey(tool, args),
    summary: summarize(tool, args),
    at: new Date().toISOString(),
    probes: await probesFor(session.root, tool, args).catch(() => [])
  };
  try { await appendDurably(journal.path, record); } catch { return null; }
  return record;
}

// After a journaled call returned (or threw).
export async function journalDone(session, intent, result) {
  if (!intent || !session || !session.journalPath) return null;
  const failed = Boolean(result && typeof result === 'object' && (typeof result.error === 'string' || (Number.isInteger(result.exitCode) && result.exitCode !== 0)));
  const record = {
    v: JOURNAL_VERSION,
    t: 'done',
    seq: intent.seq,
    call: intent.call,
    tool: intent.tool,
    status: failed ? 'error' : 'ok',
    ...(Number.isInteger(result && result.exitCode) ? { exitCode: result.exitCode } : {}),
    result: digest(result ?? null).slice(0, 16),
    at: new Date().toISOString()
  };
  try { await appendDurably(session.journalPath, record); } catch { return null; }
  return record;
}

// Decide from the world whether an action took effect.
export async function checkProbes(root, probes = []) {
  const findings = [];
  let applied = 0;
  let notApplied = 0;
  let changed = 0;
  for (const probe of probes) {
    if (probe.kind === 'file') {
      const absolute = inside(root, probe.path);
      const now = absolute ? await hashPath(absolute) : undefined;
      if ('expected' in probe && now === probe.expected) { applied++; findings.push(probe.path + ' is in the state the call would leave'); }
      else if (now === probe.before) { notApplied++; findings.push(probe.path + ' is unchanged since before the call'); }
      else { changed++; findings.push(probe.path + ' changed since before the call' + ('expected' in probe ? ', but not to what the call would write' : '')); }
    } else if (probe.kind === 'paths') {
      const moved = [];
      for (const file of probe.files || []) {
        const absolute = inside(root, file.path);
        const now = absolute ? await hashPath(absolute) : undefined;
        if (now !== file.before) moved.push(file.path);
      }
      if (moved.length) { changed++; findings.push('changed since before the call: ' + moved.slice(0, 8).join(', ')); }
      else { notApplied++; findings.push('none of ' + (probe.files || []).map((file) => file.path).slice(0, 8).join(', ') + ' changed'); }
    } else if (probe.kind === 'git_head') {
      const now = gitHead(root);
      if (now && now !== probe.before) { changed++; findings.push('HEAD moved from ' + String(probe.before || 'none').slice(0, 12) + ' to ' + now.slice(0, 12)); }
      else { notApplied++; findings.push('HEAD is still ' + String(now || 'unborn').slice(0, 12)); }
    }
  }
  let state = 'unknown';
  if (applied && !changed && !notApplied) state = 'applied';
  else if (applied && (changed || notApplied)) state = 'partial';
  else if (changed && !notApplied) state = 'changed';
  else if (changed && notApplied) state = 'partial';
  else if (notApplied) state = 'not_applied';
  return { state, findings };
}

// Calls whose outcome the saved transcript does not reliably hold.
// `messages` is the restored transcript.
export async function reconcileJournal(root, file, messages = [], { interruptedText = 'Interrupted:' } = {}) {
  const records = await readJournal(file);
  if (!records.length) return { actions: [], records: 0 };
  const intents = new Map();
  const done = new Map();
  for (const record of records) (record.t === 'intent' ? intents : done).set(record.call || ('#' + record.seq), record);
  const toolResults = new Map();
  for (const message of messages) if (message && message.role === 'tool' && message.tool_call_id) toolResults.set(message.tool_call_id, typeof message.content === 'string' ? message.content : '');
  const actions = [];
  for (const [call, intent] of intents) {
    const finished = done.get(call);
    const transcript = toolResults.get(call);
    const placeholder = transcript !== undefined && transcript.startsWith(interruptedText);
    let kind = null;
    if (!finished) kind = 'in_doubt';
    else if (transcript === undefined || placeholder) kind = 'unrecorded';
    if (!kind) continue;
    const check = await checkProbes(root, intent.probes || []);
    actions.push({
      kind,
      call,
      tool: intent.tool,
      summary: intent.summary,
      key: intent.key,
      startedAt: intent.at,
      ...(finished ? { finished: { status: finished.status, ...(finished.exitCode !== undefined ? { exitCode: finished.exitCode } : {}), at: finished.at } } : {}),
      inTranscript: transcript !== undefined,
      state: finished && check.state === 'unknown' && finished.status === 'ok' ? 'completed' : check.state,
      findings: check.findings
    });
  }
  return { actions, records: records.length };
}

const STATE_TEXT = {
  applied: 'it took effect',
  not_applied: 'it did not take effect',
  partial: 'it partly took effect',
  changed: 'its targets changed, so it probably ran',
  completed: 'it finished successfully',
  unknown: 'OASIS cannot tell from here whether it took effect'
};

export function actionLine(action) {
  const head = action.tool + (action.summary ? ' (' + action.summary + ')' : '');
  const status = action.kind === 'in_doubt'
    ? 'was started but OASIS stopped before it returned'
    : 'finished (' + action.finished.status + (action.finished.exitCode !== undefined ? ', exit ' + action.finished.exitCode : '') + ') but its result was not saved';
  return head + ' ' + status + '; checked now: ' + STATE_TEXT[action.state] + (action.findings.length ? ' (' + action.findings.join('; ') + ')' : '') + '.';
}

// The note the model reads before its next step.
export function reconciliationNote(reconciliation) {
  const actions = reconciliation && reconciliation.actions || [];
  if (!actions.length) return '';
  return '<in-doubt-actions>OASIS stopped while these actions were in flight. It checked their targets now:\n'
    + actions.map((action) => '- ' + actionLine(action)).join('\n')
    + '\nDo not repeat an action that took effect. Repeat one that did not only if it is still needed; for "cannot tell", check its effect first (for example the remote, the service or the database).</in-doubt-actions>';
}

// Replace "Interrupted: ..." placeholders with what was found.
export function applyReconciliation(messages, reconciliation, { interruptedText = 'Interrupted:' } = {}) {
  const byCall = new Map((reconciliation && reconciliation.actions || []).map((action) => [action.call, action]));
  let replaced = 0;
  for (const message of messages || []) {
    if (!message || message.role !== 'tool' || typeof message.content !== 'string' || !message.content.startsWith(interruptedText)) continue;
    const action = byCall.get(message.tool_call_id);
    if (!action) continue;
    message.content = 'Interrupted, then checked after restart: ' + actionLine(action);
    replaced++;
  }
  return replaced;
}
