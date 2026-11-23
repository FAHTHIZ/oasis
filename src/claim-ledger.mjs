// Claim ledger: what a result asserts, and on what footing.
//
// The report contracts (src/verification-contracts.mjs) answer "is anything
// in this report unsupported?". The ledger answers the finer question the
// task model and memory need: for each checkable statement in a result, what
// kind of knowledge is it, what is it based on, and does it still hold?
//
// Each claim is one sentence (or list item) of the result that makes a
// checkable assertion: a test or build result, a citation, a quotation, a
// result-like number, or an explicit inference. Plain prose that asserts
// nothing checkable is not a claim and is left out, so a well-written answer
// is not punished for having sentences.
//
// Status, strongest footing first:
//
//   observed      the runtime saw it directly: a check that passed after the
//                 last edit, a quotation found on the page as fetched
//   calculated    every number in it was printed by code, a command or a check
//                 the agent ran
//   reported      it rests on pages the agent read: cited URLs all fetched,
//                 or numbers that only a fetched page printed. Reported is
//                 not verified: the page could be wrong. Confidence grows
//                 with independent sources (src/source-independence.mjs)
//   inferred      it says it is a conclusion ("so", "therefore", "suggests",
//                 "likely") and stands on the claims around it
//   unverified    nothing the runtime observed backs it: a cited page never
//                 fetched, a number nothing printed, "tests pass" with no
//                 passing check
//   contradicted  the evidence says otherwise: the last check failed, the
//                 quoted words are not on the page
//
// A sentence with mixed footing takes the weakest part. Every claim keeps its
// basis (ledger seqs, URLs, commands, digests and when each was observed), so
// later evidence can invalidate it: a page that changes or a check that now
// fails turns earlier claims built on it stale or contradicted, and the
// memories saved from them uncertain (invalidateClaims).

import { claimsPassing } from './claim-check.mjs';
import { lastCheck, normalizeUrl } from './evidence-ledger.mjs';
import { findQuote, pageText } from './page-store.mjs';
import { independentSources } from './source-independence.mjs';
import { citedUrls, reportedNumbers } from './verification-contracts.mjs';
import { topicSimilarity } from './claim-conflict.mjs';

export const CLAIM_STATUSES = Object.freeze(['observed', 'calculated', 'reported', 'inferred', 'unverified', 'contradicted']);
// Later invalidation adds a seventh: `stale`, a claim whose basis changed.
const RANK = { contradicted: 0, unverified: 1, stale: 2, inferred: 3, reported: 4, calculated: 5, observed: 6 };
const MAX_CLAIMS = 60;
const MAX_LOG = 200;
const INFERENCE = /\b(?:therefore|thus|hence|consequently|so (?:it|this|the|we)|this (?:suggests|implies|indicates|means)|which (?:suggests|implies|indicates|means)|suggests? that|implies that|indicates? that|likely|probably|presumably|appears? to|seems? to|must (?:be|have)|i (?:infer|conclude)|we (?:infer|conclude)|in conclusion)\b/i;
const QUOTE = /["“]([^"“”\n]{12,400})["”]/g;

/** Sentences and list items of a result, without code blocks. */
export function claimSentences(text) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, '\n');
  const out = [];
  for (const line of prose.split(/\n+/)) {
    const item = line.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '').trim();
    if (!item || /^#{1,6}\s/.test(item) || /^\|?[\s:-]+\|[\s|:-]*$/.test(item)) continue;
    // Split after . ! ? followed by space and a capital or quote, keeping
    // decimals, abbreviations like "e.g." and URLs intact.
    const parts = item.split(/(?<=[^\s.]{2}[.!?])\s+(?=[A-Z"“(\[])/);
    for (const part of parts) { const value = part.trim(); if (value.length >= 8) out.push(value); }
  }
  return out;
}

function producersOf(number, events) {
  const candidates = [number.value];
  if (number.percent) candidates.push(number.value / 100);
  const out = [];
  for (const event of events || []) {
    if (!['execution', 'command', 'check', 'fetch'].includes(event.kind) || !Array.isArray(event.numbers)) continue;
    const hit = event.numbers.some((raw) => {
      const n = Number(raw);
      return candidates.some((target) => {
        const places = number.percent && target !== number.value ? number.decimals + 2 : number.decimals;
        return Math.abs(n - target) < 1e-9 || Number(n.toFixed(Math.min(places, 15))) === Number(target.toFixed(Math.min(places, 15)));
      });
    });
    if (hit) out.push(event);
  }
  return out;
}

function basisOf(event) {
  return {
    seq: event.seq, kind: event.kind, at: event.at || null,
    ...(Number.isInteger(event.epoch) ? { epoch: event.epoch } : {}),
    ...(event.url ? { url: event.url } : {}),
    ...(event.command ? { command: event.command } : {}),
    ...(event.digest ? { digest: event.digest } : {})
  };
}

function weakest(statuses) {
  return statuses.reduce((low, status) => (RANK[status] < RANK[low] ? status : low), 'observed');
}

/** Confidence in [0, 1] for a status and its footing; a score, not a probability. */
export function claimConfidence(status, { independent = 0 } = {}) {
  switch (status) {
    case 'observed': return 0.95;
    case 'calculated': return 0.9;
    case 'reported': return Math.min(0.85, 0.55 + 0.15 * Math.max(0, independent - 1));
    case 'inferred': return 0.45;
    case 'stale': return 0.3;
    case 'unverified': return 0.2;
    default: return 0;
  }
}

/**
 * The claims a result makes, typed and with their basis.
 * `events` is the evidence ledger range of the run that wrote it.
 * `analysis`: check every result-like number (otherwise only numbers in a
 * sentence that also cites or quotes, as prose is full of numbers nobody
 * computed; same rule as the analysis contract).
 * Returns { claims: [...], counts: { observed: n, ... }, total }.
 */
export function buildClaims(text, events = [], { analysis = false, now = Date.now(), textOf = pageText } = {}) {
  const fetchEvents = new Map();
  for (const event of events || []) if (event.kind === 'fetch') { fetchEvents.set(event.url, event); if (event.finalUrl) fetchEvents.set(event.finalUrl, event); }
  const check = lastCheck(events);
  const claims = [];
  for (const sentence of claimSentences(text)) {
    if (claims.length >= MAX_CLAIMS) break;
    const statuses = [];
    const reasons = [];
    const basis = [];
    const sources = new Set();
    const kinds = new Set();
    if (claimsPassing(sentence)) {
      kinds.add('check');
      if (!check) { statuses.push('unverified'); reasons.push('no test, check or build ran'); }
      else {
        basis.push(basisOf(check));
        if (check.passed === false) { statuses.push('contradicted'); reasons.push('the last check (`' + check.command + '`) exited ' + check.exitCode); }
        else if (check.masked || !check.finished || check.passed === null) { statuses.push('unverified'); reasons.push('the last check\'s exit status is unknown'); }
        else if (check.stale) { statuses.push('unverified'); reasons.push('files changed after the last passing check'); }
        else if (check.noTests) { statuses.push('unverified'); reasons.push('the check ran no tests'); }
        else statuses.push('observed');
      }
    }
    const urls = citedUrls(sentence);
    if (urls.length) {
      kinds.add('citation');
      for (const url of urls) {
        sources.add(url);
        const event = fetchEvents.get(url);
        if (event) { basis.push(basisOf(event)); statuses.push('reported'); }
        else { statuses.push('unverified'); reasons.push(url + ' was never fetched'); }
      }
    }
    for (const match of sentence.matchAll(QUOTE)) {
      const pages = urls.filter((url) => fetchEvents.has(url)).map((url) => ({ url, text: textOf(url) })).filter((page) => page.text);
      if (!pages.length) continue;
      kinds.add('quote');
      const found = pages.map((page) => ({ page, result: findQuote(match[1], page.text) })).sort((a, b) => b.result.similarity - a.result.similarity)[0];
      if (found.result.status === 'exact') statuses.push('observed');
      else if (found.result.status === 'near') { statuses.push('unverified'); reasons.push('the quotation is close to, but not, the text on ' + found.page.url); }
      else { statuses.push('contradicted'); reasons.push('the quoted words are not on ' + found.page.url); }
    }
    const numbers = (analysis || kinds.has('citation') || kinds.has('quote')) ? reportedNumbers(sentence) : [];
    for (const number of numbers) {
      kinds.add('number');
      const producers = producersOf(number, events);
      const computed = producers.filter((event) => event.kind !== 'fetch');
      if (computed.length) { statuses.push('calculated'); basis.push(basisOf(computed[computed.length - 1])); }
      else if (producers.length) { statuses.push('reported'); for (const event of producers.slice(-2)) { basis.push(basisOf(event)); sources.add(event.url); } }
      else { statuses.push('unverified'); reasons.push(number.raw + ' was not printed by anything the agent ran or read'); }
    }
    const inference = INFERENCE.test(sentence);
    if (!kinds.size && !inference) continue;
    let status = statuses.length ? weakest(statuses) : 'inferred';
    // A conclusion is only as strong as an inference, however well sourced
    // its premises are, unless the evidence already contradicts it.
    if (inference && RANK[status] > RANK.inferred) status = 'inferred';
    if (inference) kinds.add('inference');
    const independence = sources.size ? independentSources([...sources], { textOf }) : { independent: 0, total: 0 };
    const seen = [...new Map(basis.map((item) => [item.seq, item])).values()];
    const oldest = seen.reduce((min, item) => (item.at && (!min || item.at < min) ? item.at : min), null);
    claims.push({
      id: 'cl' + (claims.length + 1),
      text: sentence.slice(0, 400),
      kinds: [...kinds],
      status,
      confidence: claimConfidence(status, { independent: independence.independent }),
      ...(reasons.length ? { reasons: [...new Set(reasons)].slice(0, 4) } : {}),
      basis: seen.slice(0, 8),
      ...(sources.size ? { sources: [...sources].slice(0, 8), independentSources: independence.independent } : {}),
      ...(oldest ? { observedAt: oldest, ageMs: Math.max(0, now - oldest) } : {})
    });
  }
  // An inference rests on the claims before it in the same result.
  for (let index = 0; index < claims.length; index += 1) {
    if (!claims[index].kinds.includes('inference')) continue;
    const premises = claims.slice(Math.max(0, index - 3), index).filter((item) => !item.kinds.includes('inference') || item.basis.length);
    if (premises.length) claims[index].dependsOn = premises.map((item) => item.id);
    if (premises.some((item) => item.status === 'contradicted')) { claims[index].status = 'unverified'; claims[index].confidence = claimConfidence('unverified'); claims[index].reasons = [...(claims[index].reasons || []), 'it builds on a contradicted claim'].slice(0, 4); }
  }
  return { claims, counts: countClaims(claims), total: claims.length };
}

export function countClaims(claims) {
  const counts = Object.fromEntries([...CLAIM_STATUSES, 'stale'].map((status) => [status, 0]));
  for (const claim of claims || []) counts[claim.status] = (counts[claim.status] || 0) + 1;
  return counts;
}

/** One line for results: "3 observed, 2 reported, 1 unverified". */
export function describeClaimCounts(counts) {
  const parts = [...CLAIM_STATUSES, 'stale'].filter((status) => counts && counts[status]).map((status) => counts[status] + ' ' + status);
  return parts.length ? parts.join(', ') : 'no checkable claims';
}

// ---------------------------------------------------------------------------
// The session's claim log, and invalidation

/** Adds a finished result's claims to the session's log, tagged with the task and turn. */
export function logClaims(session, claims, { task = null, turn = null } = {}) {
  if (!session || !Array.isArray(claims) || !claims.length) return [];
  if (!Array.isArray(session.claimLog)) session.claimLog = [];
  const base = session.claimSeq || 0;
  const added = claims.map((claim, index) => ({ ...claim, id: 'C' + (base + index + 1), ...(task ? { task } : {}), ...(turn !== null ? { turn } : {}), loggedAt: Date.now() }));
  // Rewrite in-result dependency ids (cl2) to log ids (C14).
  const map = new Map(claims.map((claim, index) => [claim.id, added[index].id]));
  for (const claim of added) if (claim.dependsOn) claim.dependsOn = claim.dependsOn.map((id) => map.get(id) || id);
  session.claimSeq = base + added.length;
  session.claimLog.push(...added);
  if (session.claimLog.length > MAX_LOG) session.claimLog.splice(0, session.claimLog.length - MAX_LOG);
  return added;
}

/**
 * Checks new evidence against the claims already logged. A page fetched
 * again with different content makes the claims that cited it `stale`; a
 * check that fails after a claim that checks passed makes that claim
 * `contradicted`. Claims that depend on an invalidated claim become `stale`
 * in turn, transitively. Returns [{ claim, was, now, reason }] for each
 * change; the log is updated in place.
 */
export function invalidateClaims(session, event) {
  const log = session && Array.isArray(session.claimLog) ? session.claimLog : [];
  if (!log.length || !event) return [];
  const changes = [];
  const mark = (claim, status, reason, { quiet = false } = {}) => {
    if (claim.status === status || claim.status === 'contradicted') return;
    changes.push({ claim: claim.id, was: claim.status, now: status, reason, text: claim.text.slice(0, 200), ...(quiet ? { quiet: true } : {}), ...(claim.savedAs ? { memories: claim.savedAs } : {}) });
    claim.status = status;
    claim.confidence = claimConfidence(status);
    claim.invalidated = { at: Date.now(), reason, bySeq: event.seq || null };
  };
  if (event.kind === 'fetch' && event.url && event.digest) {
    const url = normalizeUrl(event.url);
    for (const claim of log) {
      const old = (claim.basis || []).find((item) => item.kind === 'fetch' && item.url === url && item.digest && item.seq !== event.seq);
      if (old && old.digest !== event.digest) mark(claim, 'stale', url + ' changed since the claim was made');
    }
  }
  if (event.kind === 'check' && event.passed === false) {
    for (const claim of log) {
      if (!claim.kinds.includes('check') || claim.status !== 'observed') continue;
      const before = (claim.basis || []).find((item) => item.kind === 'check');
      if (!before || before.seq >= (event.seq || Infinity)) continue;
      // Files changed in between: the claim was true of older code. It no
      // longer describes the workspace, but nobody was wrong.
      if (Number.isInteger(before.epoch) && Number.isInteger(event.epoch) && before.epoch !== event.epoch) mark(claim, 'stale', 'files changed since, and a later check (`' + event.command + '`) failed', { quiet: true });
      else mark(claim, 'contradicted', 'a later check (`' + event.command + '`) of the same files failed with exit code ' + event.exitCode);
    }
  }
  // Propagate through dependencies until nothing changes.
  let moved = changes.length > 0;
  while (moved) {
    moved = false;
    const fallen = new Set(log.filter((claim) => claim.invalidated).map((claim) => claim.id));
    for (const claim of log) {
      if (claim.invalidated || !claim.dependsOn || !claim.dependsOn.some((id) => fallen.has(id))) continue;
      mark(claim, 'stale', 'it builds on ' + claim.dependsOn.filter((id) => fallen.has(id)).join(', ') + ', which no longer holds', { quiet: changes.every((change) => change.quiet) });
      moved = true;
    }
  }
  return changes;
}

// Link text and URLs carry no topic: "[Agency](https://...)" -> "Agency".
function plainText(text) {
  return String(text || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ');
}

/**
 * Links a saved memory to the logged claims it restates (same URL in its
 * evidence, or a close topic match), so invalidating a claim reaches the
 * memory. Returns the linked claim ids.
 */
export function linkMemoryToClaims(session, memoryId, { content = '', evidence = '' } = {}) {
  const log = session && Array.isArray(session.claimLog) ? session.claimLog : [];
  if (!log.length || !memoryId) return [];
  const evidenceUrls = new Set(citedUrls(String(evidence || '') + ' ' + String(content || '')));
  const linked = [];
  for (const claim of log) {
    const sharesUrl = (claim.sources || []).some((url) => evidenceUrls.has(url));
    const close = topicSimilarity(plainText(claim.text), plainText(content)) >= 0.45;
    if (!sharesUrl && !close) continue;
    claim.savedAs = [...new Set([...(claim.savedAs || []), String(memoryId)])].slice(-10);
    linked.push(claim.id);
  }
  return linked;
}

/** A system reminder naming invalidated claims, or '' when there are none. */
export function invalidationReminder(changes) {
  changes = (changes || []).filter((change) => !change.quiet);
  if (!changes.length) return '';
  return '<system-reminder>Evidence changed under claims made earlier in this session:\n'
    + changes.slice(0, 6).map((change) => '- ' + change.claim + ' "' + change.text.slice(0, 140) + '" is now ' + change.now + ': ' + change.reason).join('\n')
    + '\nIf your answer or a saved memory relies on them, correct it or say it no longer holds.</system-reminder>';
}

const memoryJobs = new WeakMap();

/**
 * invalidateClaims for one new evidence event, with the consequences: the
 * changes the model should hear about are queued for its next step
 * (claimInvalidationNotice), and memories saved from an invalidated claim
 * are marked uncertain with a note naming the cause.
 */
export function applyClaimInvalidation(session, event, { env = process.env } = {}) {
  let changes = [];
  try { changes = invalidateClaims(session, event); } catch { return []; }
  if (!changes.length) return changes;
  const loud = changes.filter((change) => !change.quiet);
  if (loud.length) session.pendingClaimChanges = [...(session.pendingClaimChanges || []), ...loud].slice(-12);
  const revisions = changes.filter((change) => change.memories && change.memories.length);
  if (revisions.length && session.root) {
    const job = import('./auto-memory.mjs').then(({ verifyMemory }) => Promise.all(revisions.flatMap((change) => change.memories.map((memoryId) => verifyMemory(session.root, memoryId, {
      status: change.now === 'contradicted' ? 'outdated' : 'uncertain',
      evidence: 'Saved from claim ' + change.claim + ' ("' + change.text.slice(0, 120) + '"), which is now ' + change.now + ': ' + change.reason + '.',
      env
    }).catch(() => null))))).catch(() => null);
    memoryJobs.set(session, Promise.all([memoryJobs.get(session), job]));
  }
  return changes;
}

/** Resolves when memory revisions started by invalidated claims are written. */
export function settledClaimRevisions(session) {
  return Promise.resolve(session && memoryJobs.get(session)).then(() => undefined);
}

/** The queued reminder for the model's next step, once; '' when nothing is queued. */
export function claimInvalidationNotice(session) {
  const pending = session && session.pendingClaimChanges;
  if (!pending || !pending.length) return '';
  session.pendingClaimChanges = [];
  return invalidationReminder(pending);
}

/** Bounded, JSON-safe copy of the log for sessions. */
export function claimLogSnapshot(session) {
  return Array.isArray(session && session.claimLog) ? session.claimLog.slice(-MAX_LOG) : [];
}

export function restoreClaimLog(session, saved) {
  if (!session || !Array.isArray(saved)) return;
  session.claimLog = saved.filter((claim) => claim && typeof claim === 'object' && typeof claim.id === 'string' && typeof claim.text === 'string' && Array.isArray(claim.kinds)).slice(-MAX_LOG);
  session.claimSeq = session.claimLog.reduce((max, claim) => Math.max(max, Number(claim.id.slice(1)) || 0), 0);
}

