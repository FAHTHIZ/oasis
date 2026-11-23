// Domain verification contracts (roadmap 1.6).
//
// A contract reads a final report and the evidence ledger range of the agent
// that wrote it (src/evidence-ledger.mjs) and lists the claims the evidence
// does not support. Three domains:
//
//   code      A report that says tests, builds or checks pass needs a check
//             event that finished with exit code 0, was not hidden by a pipe,
//             and has no edit after it. Same rules as src/claim-check.mjs.
//   research  Every URL the report cites must have been fetched (fetch_url or
//             the browser). A URL that only appeared in search results was
//             never read, so citing it is flagged. Words quoted next to a
//             cited URL must appear on that page as fetched (a misquote).
//   analysis  Every result-like number in the report (a decimal, a percentage,
//             or an integer of three or more digits that is not a year) must
//             have been printed by an execution, command, check or fetched
//             page. Rounding is allowed: 0.4567 supports 0.46 and 45.7%.
//
// `code` and `research` run whenever their claims appear. `analysis` runs when
// the agent declared that domain, or when it executed code and ran no test or
// build (a computation rather than a fix), because ordinary prose is full of
// numbers nobody computed.

import { claimsPassing } from './claim-check.mjs';
import { fetchedUrls, lastCheck, normalizeUrl, producedNumbers, searchedUrls } from './evidence-ledger.mjs';
import { checkQuotes } from './page-store.mjs';

export const CONTRACT_DOMAINS = Object.freeze(['code', 'research', 'analysis']);
const MAX_LISTED = 5;

export function codeContract(text, events) {
  if (!claimsPassing(text)) return [];
  const check = lastCheck(events);
  if (!check) return [{ domain: 'code', reason: 'the report says checks pass, but the agent ran no test, check, lint or build command' }];
  if (check.masked) return [{ domain: 'code', reason: 'the report says checks pass, but the exit status of the agent\'s last check (`' + check.command + '`) was hidden by a pipe' }];
  if (!check.finished) return [{ domain: 'code', reason: 'the report says checks pass, but the agent\'s last check (`' + check.command + '`) did not finish' }];
  if (check.passed === false) return [{ domain: 'code', reason: 'the report says checks pass, but the agent\'s last ' + (check.checkKind || 'check') + ' command exited with code ' + (check.exitCode === null ? 'unknown' : check.exitCode) }];
  if (check.stale) return [{ domain: 'code', reason: 'the report says checks pass, but the agent edited files after its last passing check' }];
  return [];
}

export function citedUrls(text) {
  const out = new Set();
  const value = String(text || '');
  for (const match of value.matchAll(/\]\((https?:\/\/[^)\s]+)\)/g)) { const url = normalizeUrl(match[1]); if (url) out.add(url); }
  for (const match of value.matchAll(/(?<![(\w])https?:\/\/[^\s<>()"'`\]]+/g)) { const url = normalizeUrl(match[0]); if (url) out.add(url); }
  return [...out];
}

export function researchContract(text, events) {
  const cited = citedUrls(text);
  if (!cited.length) return [];
  const fetched = fetchedUrls(events);
  const searched = searchedUrls(events);
  const unread = cited.filter((url) => !fetched.has(url));
  if (!unread.length) return [];
  const onlySearched = unread.filter((url) => searched.has(url));
  const listed = unread.slice(0, MAX_LISTED).join(', ') + (unread.length > MAX_LISTED ? ' and ' + (unread.length - MAX_LISTED) + ' more' : '');
  return [{
    domain: 'research',
    reason: 'the report cites ' + unread.length + ' URL' + (unread.length === 1 ? '' : 's') + ' the agent never fetched (' + listed + ')' + (onlySearched.length ? '; ' + onlySearched.length + ' only appeared in search results' : ''),
    urls: unread
  }];
}

// Words in quotation marks next to a cited URL must be on that page, as the
// agent fetched it (src/page-store.mjs). Pages fetched before a restart have
// no stored text and are skipped.
export function quoteContract(text, events) {
  const fetched = fetchedUrls(events);
  if (!fetched.size) return [];
  const { misquotes } = checkQuotes(text, citedUrls, { fetched });
  if (!misquotes.length) return [];
  const first = misquotes[0];
  return [{
    domain: 'research',
    reason: 'the report quotes ' + misquotes.length + ' passage' + (misquotes.length === 1 ? '' : 's') + ' that the cited page does not contain, for example "' + first.quote.slice(0, 120) + '" (' + first.urls[0] + (first.closest ? '; closest text there: "' + first.closest.slice(0, 160) + '"' : '') + ')',
    misquotes: misquotes.slice(0, MAX_LISTED)
  }];
}

const YEAR = /^(?:19|20)\d\d$/;

// Result-like numbers from prose: decimals, percentages and integers of three
// or more digits, skipping years, list markers, versions and code spans.
export function reportedNumbers(text) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ').replace(/https?:\/\/\S+/g, ' ');
  const out = [];
  for (const match of prose.matchAll(/(?<![\w.\-/:])-?\d[\d,]*(?:\.\d+)?%?(?![\w.]*\d)(?![\w/])/g)) {
    const raw = match[0];
    const percent = raw.endsWith('%');
    const digits = raw.replace(/[%,-]/g, '');
    if (!percent && !digits.includes('.') && (digits.length < 3 || YEAR.test(digits))) continue;
    out.push({ raw, value: Number(raw.replace(/[%,]/g, '')), decimals: (digits.split('.')[1] || '').length, percent });
  }
  return out;
}

function supported(number, produced) {
  const candidates = [number.value];
  if (number.percent) candidates.push(number.value / 100);
  for (const value of produced) {
    const n = Number(value);
    for (const target of candidates) {
      const places = number.percent && target !== number.value ? number.decimals + 2 : number.decimals;
      if (Math.abs(n - target) < 1e-9) return true;
      if (Number(n.toFixed(Math.min(places, 15))) === Number(target.toFixed(Math.min(places, 15)))) return true;
    }
  }
  return false;
}

export function analysisContract(text, events) {
  const numbers = reportedNumbers(text);
  if (!numbers.length) return [];
  const produced = producedNumbers(events);
  const missing = numbers.filter((number) => !supported(number, produced));
  if (!missing.length) return [];
  const listed = [...new Set(missing.map((number) => number.raw))];
  return [{
    domain: 'analysis',
    reason: 'the report gives ' + listed.length + ' number' + (listed.length === 1 ? '' : 's') + ' that no execution, command or fetched page produced (' + listed.slice(0, MAX_LISTED).join(', ') + (listed.length > MAX_LISTED ? ' and ' + (listed.length - MAX_LISTED) + ' more' : '') + ')',
    numbers: listed
  }];
}

function analysisApplies(events, domains) {
  if (domains.includes('analysis')) return true;
  // Code that ran without any test or build around it: a computation, not a fix.
  return (events || []).some((event) => event.kind === 'execution') && !(events || []).some((event) => event.kind === 'check');
}

/**
 * Runs the contracts for a report. `domains` are the agent's declared domains
 * (from its definition's `domain:` field); code and research always apply.
 * Returns a list of { domain, reason } issues, empty when every claim is supported.
 */
export function checkReport(text, events, { domains = [] } = {}) {
  const declared = (Array.isArray(domains) ? domains : [domains]).map((domain) => String(domain || '').toLowerCase()).filter((domain) => CONTRACT_DOMAINS.includes(domain));
  const issues = [...codeContract(text, events), ...researchContract(text, events), ...quoteContract(text, events)];
  if (analysisApplies(events, declared)) issues.push(...analysisContract(text, events));
  return issues;
}
