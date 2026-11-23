// Verifiable work receipts.
//
// A reply that says "fixed, tests pass" asks the reader to trust it. A
// receipt lets them check it instead, without trusting the agent, the model
// or OASIS itself:
//
//   - what was asked, what was answered, and which model answered;
//   - every piece of evidence the runtime recorded (checks and their exit
//     codes, commands, fetched pages, edits, side effects), each linked to the
//     one before it by a SHA-256 hash chain, so removing, reordering or
//     editing an event breaks the chain;
//   - every checkable claim in the answer, typed by the claim ledger
//     (observed, calculated, reported, inferred, unverified, contradicted),
//     with the evidence events it rests on;
//   - the workspace it applies to: git commit, branch, a digest of the
//     uncommitted diff, and the SHA-256 of every file the run edited;
//   - the checks needed to reproduce the result (`replay`);
//   - an Ed25519 signature over all of the above, made with a key that
//     lives on the machine that did the work.
//
// `verifyReceipt` checks the signature, the chain, that each claim's basis is
// in the chain, that the files on disk are the files the run produced and,
// with `replay`, reruns the checks and compares their outcome with the
// recorded one. A receipt that passes all of these says more than any reply:
// the work it describes is the work in front of you, and it reproduces.
//
// Receipts are plain JSON (format `oasis.receipt/v1`) so other tools can
// produce and verify them; the canonical form for hashing and signing is JSON
// with object keys sorted, no whitespace.

import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { getConfigDirectory } from './config.mjs';
import { sessionEvidence } from './evidence-ledger.mjs';
import { buildClaims, countClaims } from './claim-ledger.mjs';
import { redactSecretText } from './secret-shield.mjs';
import { oasisVersion } from './version.mjs';

const execFileAsync = promisify(execFile);

export const RECEIPT_FORMAT = 'oasis.receipt/v1';
const GENESIS = '0'.repeat(64);
const MAX_TEXT = 20000;
const MAX_EVENTS = 2000;
const MAX_FILES = 500;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const MAX_REPLAY = 10;
const REPLAY_TIMEOUT_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------- canonical form

/** JSON with sorted object keys and no whitespace: the form that is hashed and signed. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value === undefined ? null : value);
  }
  if (Array.isArray(value)) return '[' + value.map((item) => canonicalJson(item === undefined ? null : item)).join(',') + ']';
  const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
  return '{' + keys.map((key) => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}

export function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : canonicalJson(value)).digest('hex');
}

// ---------------------------------------------------------------- signing key

/** The machine's receipt key: Ed25519, created on first use, private part readable only by the user. */
export async function receiptKey({ env = process.env, directory = '' } = {}) {
  const dir = directory || path.join(getConfigDirectory(env), 'receipts');
  const file = path.join(dir, 'signing-key.pem');
  let privateKey;
  if (existsSync(file)) {
    privateKey = createPrivateKey(await readFile(file, 'utf8'));
  } else {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const pair = generateKeyPairSync('ed25519');
    privateKey = pair.privateKey;
    await writeFile(file, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600, flag: 'wx' }).catch(async (error) => {
      // Another process created it first: use theirs.
      if (error.code !== 'EEXIST') throw error;
      privateKey = createPrivateKey(await readFile(file, 'utf8'));
    });
  }
  const publicKey = createPublicKey(privateKey);
  const publicDer = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, publicKey: publicDer.toString('base64'), keyId: keyIdOf(publicDer), file };
}

/** A signing key from a PEM private key held in memory (CI secrets), never written to disk. */
export function receiptKeyFromPem(pem) {
  const privateKey = createPrivateKey(String(pem).replace(/\\n/g, '\n').trim() + '\n');
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('The receipt signing key must be an Ed25519 private key (PEM).');
  const publicDer = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  return { privateKey, publicKey: publicDer.toString('base64'), keyId: keyIdOf(publicDer), file: '' };
}

/**
 * Key id of this machine's receipt key, or null when none exists yet. Unlike
 * receiptKey() this never creates a key: verifying must not have side effects.
 */
export async function localReceiptKeyId({ env = process.env, directory = '' } = {}) {
  const file = path.join(directory || path.join(getConfigDirectory(env), 'receipts'), 'signing-key.pem');
  try {
    const publicDer = createPublicKey(createPrivateKey(await readFile(file, 'utf8'))).export({ type: 'spki', format: 'der' });
    return keyIdOf(publicDer);
  } catch { return null; }
}

export function keyIdOf(publicDer) {
  return 'ed25519:' + createHash('sha256').update(Buffer.isBuffer(publicDer) ? publicDer : Buffer.from(String(publicDer), 'base64')).digest('hex').slice(0, 32);
}

// ---------------------------------------------------------------- building

function clip(text, max = MAX_TEXT) {
  const value = redactSecretText(String(text ?? ''));
  return value.length > max ? value.slice(0, max) + '\n[clipped ' + (value.length - max) + ' characters]' : value;
}

// Only the fields a verifier needs; tool output itself stays out (its digest stands for it).
const EVENT_FIELDS = ['seq', 'at', 'epoch', 'kind', 'tool', 'command', 'checkKind', 'exitCode', 'finished', 'passed', 'masked', 'noTests', 'filtered', 'mayEdit', 'url', 'finalUrl', 'query', 'path', 'changed', 'rehearsal', 'unrehearsed', 'digest'];

function receiptEvent(event) {
  const out = {};
  for (const key of EVENT_FIELDS) {
    if (event[key] === undefined || event[key] === null || event[key] === false && !['finished', 'passed'].includes(key)) continue;
    out[key] = typeof event[key] === 'string' ? redactSecretText(event[key]).slice(0, 400)
      : Array.isArray(event[key]) ? event[key].filter((item) => typeof item === 'string').map((item) => redactSecretText(item).slice(0, 400))
        : event[key];
  }
  return out;
}

/** Links each event to the one before it: link = sha256(previous link + canonical event). */
export function chainEvents(events) {
  let previous = GENESIS;
  return events.map((event) => {
    const link = sha256(previous + canonicalJson(event));
    previous = link;
    return { ...event, link };
  });
}

async function git(root, args) {
  try {
    const { stdout } = await execFileAsync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024, timeout: 30000 });
    return stdout;
  } catch { return null; }
}

/** Git commit, branch and a digest of the uncommitted diff, or null outside a repository. */
export async function workspaceState(root) {
  const head = await git(root, ['rev-parse', 'HEAD']);
  if (head === null) return null;
  const branch = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = await git(root, ['status', '--porcelain=v1', '--untracked-files=normal']);
  const diff = await git(root, ['diff', 'HEAD', '--binary']);
  return {
    head: head.trim(),
    branch: String(branch || '').trim(),
    dirty: Boolean(String(status || '').trim()),
    diffDigest: sha256(String(diff || '')),
    changed: String(status || '').split('\n').filter(Boolean).length
  };
}

async function fileDigest(root, relative) {
  const full = path.resolve(root, relative);
  const inside = path.relative(path.resolve(root), full);
  if (!inside || inside.startsWith('..') || path.isAbsolute(inside)) return null;
  try {
    const info = await stat(full);
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return { path: inside.split(path.sep).join('/'), missing: !info.isFile(), bytes: info.size };
    const body = await readFile(full);
    return { path: inside.split(path.sep).join('/'), sha256: sha256(body), bytes: body.length };
  } catch { return { path: inside.split(path.sep).join('/'), missing: true }; }
}

/** The checks to rerun: the latest run of each distinct command since the last edit, newest last. */
export function replayPlan(events) {
  const lastEdit = events.reduce((max, event) => (event.kind === 'edit' || event.mayEdit || (Array.isArray(event.changed) && event.changed.length) ? Math.max(max, event.seq) : max), 0);
  const byCommand = new Map();
  for (const event of events) {
    if (event.kind !== 'check' || !event.finished || event.masked || !event.command || event.seq < lastEdit) continue;
    byCommand.delete(event.command);
    byCommand.set(event.command, { command: event.command, checkKind: event.checkKind || 'test', expect: event.passed ? 'pass' : 'fail', exitCode: event.exitCode, seq: event.seq });
  }
  return [...byCommand.values()].slice(-MAX_REPLAY);
}

/**
 * Builds the unsigned receipt body for a session's work.
 * `request` and `reply` default to the session's last user and assistant messages.
 */
export async function buildReceipt(session, { request = null, reply = null, result = null, root = '', fromSeq = 0, now = Date.now() } = {}) {
  const workspace = path.resolve(root || (session && session.root) || process.cwd());
  const ledger = sessionEvidence(session) || { events: [] };
  const raw = (ledger.events || []).filter((event) => event.seq > fromSeq).slice(-MAX_EVENTS);
  const events = chainEvents(raw.map(receiptEvent));
  const messages = Array.isArray(session && session.messages) ? session.messages : [];
  const textOf = (message) => typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((part) => part && (part.text || '')).join('') : '';
  const lastUser = [...messages].reverse().find((message) => message && message.role === 'user' && !/^<(?:system-reminder|task-notification)/.test(textOf(message)));
  const lastAssistant = [...messages].reverse().find((message) => message && message.role === 'assistant' && textOf(message).trim());
  const requestText = request ?? (session && session.currentRequest) ?? (lastUser ? textOf(lastUser) : '');
  const replyText = reply ?? (result && result.text) ?? (lastAssistant ? textOf(lastAssistant) : '');
  const built = buildClaims(replyText, raw, { textOf: () => '' });
  const claims = built.claims.map((claim) => ({
    id: claim.id,
    text: redactSecretText(claim.text),
    status: claim.status,
    kinds: claim.kinds,
    basis: (claim.basis || []).map((item) => item.seq).filter(Number.isInteger),
    ...(claim.reasons ? { reasons: claim.reasons } : {})
  }));
  // Files edited by tools, and files commands were observed to change (formatters, code
  // generators, sed -i, snapshot updates): the receipt attests both.
  const edited = [...new Set(raw.flatMap((event) => [
    ...(event.kind === 'edit' && event.path ? [event.path] : []),
    ...(Array.isArray(event.changed) ? event.changed : [])
  ]))].slice(0, MAX_FILES);
  const files = (await Promise.all(edited.map((file) => fileDigest(workspace, file)))).filter(Boolean);
  const task = session && session.task ? session.task : null;
  const outcome = task && task.outcome ? task.outcome : null;
  return {
    format: RECEIPT_FORMAT,
    issuedAt: new Date(now).toISOString(),
    producer: { name: 'oasis', version: oasisVersion() },
    subject: {
      workspace: path.basename(workspace),
      git: await workspaceState(workspace)
    },
    run: {
      sessionId: (session && session.sessionId) || null,
      model: (session && session.config && session.config.model) || null,
      request: clip(requestText),
      reply: clip(replyText),
      ...(task ? { task: { intent: task.intent && task.intent.kind || null, risk: task.risk ? { level: task.risk.level, reasons: task.risk.reasons } : null, domain: task.domains && task.domains.primary || null } } : {}),
      ...(outcome ? { verdict: outcome.verdict || null } : {})
    },
    evidence: { count: events.length, head: events.length ? events[events.length - 1].link : GENESIS, events },
    claims: { counts: countClaims(built.claims), items: claims },
    files,
    replay: replayPlan(raw)
  };
}

/** Signs a receipt body with the machine key. */
export async function signReceipt(body, { key = null, env = process.env } = {}) {
  const signer = key || await receiptKey({ env });
  const { signature: _drop, ...unsigned } = body;
  const value = edSign(null, Buffer.from(canonicalJson(unsigned)), signer.privateKey).toString('base64');
  return { ...unsigned, signature: { alg: 'Ed25519', keyId: signer.keyId, publicKey: signer.publicKey, value } };
}

export async function createReceipt(session, options = {}) {
  return signReceipt(await buildReceipt(session, options), options);
}

export async function writeReceipt(file, receipt) {
  await mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await writeFile(file, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o644 });
  return path.resolve(file);
}

// ---------------------------------------------------------------- verifying

function check(name, ok, detail, { level = 'error' } = {}) {
  return { name, ok: Boolean(ok), level: ok ? 'ok' : level, detail };
}

function runReplay(command, root, timeoutMs) {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', command] : ['-c', command];
    const child = spawn(shell, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: process.env.CI || '1' } });
    let tail = '';
    const keep = (chunk) => { tail = (tail + chunk.toString()).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); resolve({ exitCode: null, error: error.message, tail }); });
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ exitCode: Number.isInteger(code) ? code : null, signal, tail }); });
  });
}

/**
 * Verifies a receipt. Options:
 *   root        workspace to compare files and git state against (omit to check the receipt alone)
 *   replay      rerun the replay checks in `root` (runs commands: only for receipts you trust)
 *   trustedKeys key ids that may sign; empty means any valid signature
 *   localKeyId  this machine's key id (default: read from the config directory)
 *   onReplay    called with each command before it runs
 * Returns { status, ok, checks, summary }.
 * status: verified | reproduced | drifted | unsupported | failed_replay | untrusted_signer | tampered | invalid
 *
 * The public key travels inside the receipt, so a valid signature alone only
 * shows the receipt is unchanged since some key signed it: anyone can make
 * one. Replay therefore runs commands only from a trusted signer (trustedKeys,
 * or this machine's own key); a forged receipt with `curl ... | sh` in its
 * replay plan must not run just because it signed itself.
 */
export async function verifyReceipt(receipt, { root = '', replay = false, trustedKeys = [], localKeyId, env = process.env, onReplay = null, timeoutMs = REPLAY_TIMEOUT_MS } = {}) {
  const checks = [];
  if (!receipt || typeof receipt !== 'object' || receipt.format !== RECEIPT_FORMAT) {
    return { status: 'invalid', ok: false, checks: [check('format', false, 'not an ' + RECEIPT_FORMAT + ' receipt')], summary: 'Not an OASIS receipt.' };
  }
  // 1. Signature over everything but the signature.
  const sig = receipt.signature || {};
  let signed = false;
  try {
    const { signature: _drop, ...unsigned } = receipt;
    const publicKey = createPublicKey({ key: Buffer.from(String(sig.publicKey || ''), 'base64'), format: 'der', type: 'spki' });
    const idMatches = keyIdOf(String(sig.publicKey || '')) === sig.keyId;
    signed = sig.alg === 'Ed25519' && idMatches && edVerify(null, Buffer.from(canonicalJson(unsigned)), publicKey, Buffer.from(String(sig.value || ''), 'base64'));
  } catch { signed = false; }
  checks.push(check('signature', signed, signed ? 'valid Ed25519 signature by ' + sig.keyId : 'the signature does not match the contents: the receipt was altered or not signed'));
  const ownKey = localKeyId === undefined ? await localReceiptKeyId({ env }) : localKeyId;
  const fromThisMachine = signed && Boolean(ownKey) && sig.keyId === ownKey;
  const trustedSigner = signed && (trustedKeys.includes(sig.keyId) || fromThisMachine);
  if (signed && trustedKeys.length) {
    const trusted = trustedKeys.includes(sig.keyId);
    checks.push(check('signer', trusted, trusted ? sig.keyId + ' is trusted' : sig.keyId + ' is not one of the trusted keys'));
  } else if (signed) {
    checks.push(check('signer', fromThisMachine, fromThisMachine ? 'signed by this machine\'s receipt key'
      : sig.keyId + ' is not this machine\'s key and was not passed with --trust: the signature shows only that the receipt is unchanged since that key signed it, not who wrote it', { level: 'warning' }));
  }
  // 2. Evidence chain.
  const events = Array.isArray(receipt.evidence && receipt.evidence.events) ? receipt.evidence.events : [];
  let previous = GENESIS;
  let broken = -1;
  for (let index = 0; index < events.length; index += 1) {
    const { link, ...event } = events[index];
    const expected = sha256(previous + canonicalJson(event));
    if (link !== expected) { broken = index; break; }
    previous = link;
  }
  const chainOk = broken < 0 && previous === (receipt.evidence && receipt.evidence.head) && events.length === (receipt.evidence && receipt.evidence.count);
  checks.push(check('evidence chain', chainOk, chainOk ? events.length + ' events, chain intact' : broken >= 0 ? 'event ' + (broken + 1) + ' does not link to the one before it' : 'chain head or count does not match'));
  // 3. Claims rest on evidence that is in the chain, and are what they say.
  const bySeq = new Map(events.map((event) => [event.seq, event]));
  const claims = Array.isArray(receipt.claims && receipt.claims.items) ? receipt.claims.items : [];
  const dangling = claims.filter((claim) => (claim.basis || []).some((seq) => !bySeq.has(seq)));
  const falseObserved = claims.filter((claim) => claim.status === 'observed' && claim.kinds && claim.kinds.includes('check') && !(claim.basis || []).some((seq) => bySeq.get(seq) && bySeq.get(seq).kind === 'check' && bySeq.get(seq).passed === true));
  const contradicted = claims.filter((claim) => claim.status === 'contradicted');
  const unverified = claims.filter((claim) => claim.status === 'unverified');
  checks.push(check('claim basis', !dangling.length && !falseObserved.length, dangling.length ? dangling.length + ' claim(s) cite evidence that is not in the receipt' : falseObserved.length ? falseObserved.length + ' claim(s) marked observed without a passing check' : claims.length + ' claim(s), each backed by evidence in the chain'));
  if (contradicted.length) checks.push(check('claims', false, contradicted.length + ' claim(s) in the reply are contradicted by the evidence: ' + contradicted.slice(0, 3).map((claim) => '"' + claim.text.slice(0, 80) + '"').join('; '), { level: 'warning' }));
  else if (unverified.length) checks.push(check('claims', false, unverified.length + ' claim(s) in the reply are not backed by evidence', { level: 'warning' }));
  // 3b. Rehearsals: which actions ran after a rehearsal the person saw, and whether the
  // real run stayed inside it. Informational: a divergence is not tampering.
  const rehearsed = events.filter((event) => typeof event.rehearsal === 'string');
  if (rehearsed.length) {
    const diverged = rehearsed.filter((event) => event.rehearsal === 'diverged');
    const applied = rehearsed.filter((event) => event.rehearsal === 'applied').length;
    const matched = rehearsed.filter((event) => event.rehearsal === 'matched').length;
    checks.push(check('rehearsals', !diverged.length, diverged.length
      ? diverged.length + ' of ' + rehearsed.length + ' rehearsed action(s) changed files the rehearsal did not show: ' + diverged.slice(0, 3).map((event) => (event.command || event.tool || 'event ' + event.seq).slice(0, 60) + ' (' + (event.unrehearsed || []).slice(0, 5).join(', ') + ')').join('; ')
      : rehearsed.length + ' rehearsed action(s): ' + [applied ? applied + ' applied from the rehearsal' : '', matched ? matched + ' matched it' : '', rehearsed.length - applied - matched ? (rehearsed.length - applied - matched) + ' with an incomplete rehearsal' : ''].filter(Boolean).join(', '), { level: 'warning' }));
  }
  // 4. The workspace in front of us is the one the receipt describes.
  let drift = false;
  if (root) {
    const workspace = path.resolve(root);
    const files = Array.isArray(receipt.files) ? receipt.files : [];
    const mismatched = [];
    for (const file of files) {
      const now = await fileDigest(workspace, file.path);
      if (!now) continue;
      if (file.missing ? !now.missing : now.missing || now.sha256 !== file.sha256) mismatched.push(file.path);
    }
    drift = mismatched.length > 0;
    checks.push(check('files', !drift, drift ? mismatched.length + ' file(s) differ from the receipt: ' + mismatched.slice(0, 5).join(', ') : files.length + ' edited file(s) match', { level: 'warning' }));
    const recorded = receipt.subject && receipt.subject.git;
    if (recorded) {
      const current = await workspaceState(workspace);
      const same = current && current.head === recorded.head && current.diffDigest === recorded.diffDigest;
      checks.push(check('git state', same, same ? 'commit ' + recorded.head.slice(0, 12) + ' with the same uncommitted changes' : current ? (current.head === recorded.head ? 'same commit, different uncommitted changes' : 'different commit (' + current.head.slice(0, 12) + ' here, ' + recorded.head.slice(0, 12) + ' in the receipt)') : 'not a git repository here', { level: 'warning' }));
      if (!same) drift = true;
    }
  }
  // 5. Replay: the recorded checks give the recorded outcome again.
  let replayFailed = false;
  let replayRefused = false;
  let replayed = 0;
  if (replay) {
    if (!signed) checks.push(check('replay', false, 'refused: the receipt is not validly signed, so its commands are not run'));
    else if (!trustedSigner) { replayRefused = true; checks.push(check('replay', false, 'refused: ' + sig.keyId + ' is not a trusted signer, so the receipt\'s commands are not run. Pass --trust ' + sig.keyId + ' if you know who holds that key')); }
    else if (!root) checks.push(check('replay', false, 'needs a workspace to run in'));
    else {
      const plan = Array.isArray(receipt.replay) ? receipt.replay.slice(0, MAX_REPLAY) : [];
      if (!plan.length) checks.push(check('replay', false, 'the receipt records no check to rerun', { level: 'warning' }));
      for (const step of plan) {
        if (onReplay) onReplay(step);
        const outcome = await runReplay(step.command, path.resolve(root), timeoutMs);
        const got = outcome.exitCode === 0 ? 'pass' : 'fail';
        const same = got === step.expect;
        replayed += 1;
        if (!same) replayFailed = true;
        checks.push(check('replay: ' + step.command.slice(0, 80), same, same ? 'reproduced (' + got + ', exit ' + outcome.exitCode + ')' : 'recorded ' + step.expect + ', got ' + got + ' (exit ' + outcome.exitCode + ')' + (outcome.tail ? '\n' + outcome.tail.split('\n').slice(-8).join('\n') : '')));
      }
    }
  }
  const tampered = !signed || !chainOk || dangling.length > 0 || falseObserved.length > 0 || checks.some((item) => item.name === 'signer' && item.level === 'error');
  const status = tampered ? 'tampered'
    : replayRefused ? 'untrusted_signer'
    : replayFailed ? 'failed_replay'
    : drift ? 'drifted'
    : contradicted.length || unverified.length ? 'unsupported'
    : replay && replayed ? 'reproduced'
    : 'verified';
  const SUMMARY = {
    tampered: 'Do not trust this receipt: its contents do not match its signature or evidence chain.',
    untrusted_signer: 'The receipt is intact, but its signer is not trusted here, so its commands were not run.',
    failed_replay: 'The receipt is genuine, but rerunning its checks did not give the recorded result.',
    drifted: 'The receipt is genuine, but the workspace has changed since it was issued.',
    unsupported: 'The receipt is genuine, but some claims in the reply are not backed by its evidence.',
    reproduced: 'Genuine, and every recorded check reproduced here.',
    verified: 'Genuine: signature and evidence chain hold, and every claim rests on recorded evidence.'
  };
  const summary = SUMMARY[status] + (signed && !trustedSigner && status !== 'tampered' && status !== 'untrusted_signer'
    ? ' Its signer is not trusted here, so this shows only that it is unchanged since that key signed it; pass --trust ' + sig.keyId + ' if you know who holds that key.' : '');
  return { status, ok: status === 'verified' || status === 'reproduced', checks, summary, trustedSigner };
}

/** Human-readable report for the terminal. */
export function formatVerification(receipt, verdict) {
  const lines = [];
  const run = receipt && receipt.run || {};
  if (verdict.status !== 'invalid') {
    lines.push('Receipt ' + [receipt.issuedAt || 'undated', run.model || 'unknown model', receipt.subject && receipt.subject.workspace].filter(Boolean).join(' · '));
    if (typeof run.request === 'string' && run.request) lines.push('Asked:   ' + run.request.split('\n')[0].slice(0, 120));
    lines.push('');
  }
  for (const item of verdict.checks) lines.push((item.ok ? '  ok    ' : item.level === 'warning' ? '  warn  ' : '  FAIL  ') + item.name + ': ' + item.detail.split('\n').join('\n          '));
  lines.push('');
  lines.push(verdict.status.toUpperCase() + ': ' + verdict.summary);
  return lines.join('\n');
}

export async function readReceipt(file) {
  const text = await readFile(file, 'utf8');
  try { return JSON.parse(text); } catch { throw new Error(file + ' is not valid JSON.'); }
}
