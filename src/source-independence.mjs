// Source independence: how many sources really back a claim?
//
// Counting URLs overstates evidence. A wire story republished by twenty
// outlets, a press release copied onto news sites, docs mirrored on several
// hosts, or three pages of one site are one source, not many. Agents (and
// people) routinely report "confirmed by 5 sources" when all five trace back
// to one origin. OASIS has the text each agent fetched (src/page-store.mjs),
// so it can group sources the way a careful fact-checker would:
//
//   - same origin: the same registrable domain (docs.example.com and
//     www.example.com/blog are one site), or the same URL up to tracking
//     parameters, fragments, `www.` and AMP paths;
//   - copied text: one page contains at least 50% of the other's 6-word
//     shingles (syndication, a reprinted press release, a mirror, a scraper).
//
// The result lists independent groups; `independent` is how many there are.
// Pages without stored text (not fetched in this process) are grouped by site
// only and marked unchecked.

import { normalizeUrl } from './evidence-ledger.mjs';
import { pageText, quoteWords } from './page-store.mjs';

const SHINGLE_WORDS = 6;
const MAX_SHINGLES = 60_000;
const COPY_CONTAINMENT = 0.5;
const MIN_SHINGLES_TO_COMPARE = 20;
const MAX_URLS = 40;

// Common two-label public suffixes, so bbc.co.uk and abc.net.au group by
// their registrable domain rather than by co.uk / net.au.
const SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'or', 'ne', 'go', 'gob', 'gouv', 'mil', 'nic', 'ltd', 'plc', 'sch', 'nhs', 'police', 'res', 'info', 'biz']);
// Hosts where each user or project is a different author, so the first
// path segment or subdomain is the source.
const SHARED_HOSTS = new Set(['github.com', 'gitlab.com', 'medium.com', 'substack.com', 'github.io', 'blogspot.com', 'wordpress.com', 'tumblr.com', 'notion.site', 'vercel.app', 'netlify.app', 'pages.dev', 'herokuapp.com', 'x.com', 'twitter.com', 'reddit.com', 'youtube.com', 'linkedin.com']);
const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|cmpid$|ocid$|igshid$|si$)/i;

/** The registrable domain of a URL's host ("docs.python.org" -> "python.org"). */
export function siteOf(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.$/, ''); } catch { return ''; }
  if (!host) return '';
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const labels = host.split('.');
  if (labels.length <= 2) return host;
  const last = labels.at(-1);
  const second = labels.at(-2);
  const take = last.length === 2 && SECOND_LEVEL.has(second) ? 3 : 2;
  const domain = labels.slice(-take).join('.');
  // user.github.io, name.substack.com: each subdomain is its own author.
  if (SHARED_HOSTS.has(domain) && labels.length > take && labels[0] !== 'www') return labels.slice(-(take + 1)).join('.');
  return domain;
}

/** The author-level source: the site, or site/owner on shared hosts like github.com. */
export function sourceKey(url) {
  const site = siteOf(url);
  if (!SHARED_HOSTS.has(site)) return site;
  try {
    const owner = new URL(url).pathname.split('/').filter(Boolean)[0];
    return owner ? site + '/' + owner.toLowerCase().replace(/^@/, '') : site;
  } catch { return site; }
}

/** A URL reduced to what identifies the document. */
export function canonicalDocument(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return String(url || ''); }
  const host = parsed.hostname.toLowerCase().replace(/^(www\d?|m|amp|mobile)\./, '');
  const path = parsed.pathname.replace(/\/amp\/?$/i, '/').replace(/\/index\.(html?|php)$/i, '/').replace(/\/+$/, '') || '/';
  const query = [...parsed.searchParams].filter(([key]) => !TRACKING.test(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => key + '=' + value).join('&');
  return host + path + (query ? '?' + query : '');
}

function hashWords(words, start) {
  // FNV-1a over the joined words, as an unsigned 32-bit integer.
  let hash = 0x811c9dc5;
  for (let index = start; index < start + SHINGLE_WORDS; index += 1) {
    const word = words[index];
    for (let char = 0; char < word.length; char += 1) {
      hash ^= word.charCodeAt(char);
      hash = Math.imul(hash, 0x01000193);
    }
    hash ^= 32;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** Hashed 6-word shingles of a text (a set of integers). */
export function shingles(text) {
  const words = quoteWords(text);
  const out = new Set();
  for (let index = 0; index + SHINGLE_WORDS <= words.length && out.size < MAX_SHINGLES; index += 1) out.add(hashWords(words, index));
  return out;
}

/**
 * How much of the smaller text is contained in the larger one (0..1). High
 * containment means one page copies the other, even when the copy adds its
 * own header, footer or commentary.
 */
export function containment(left, right) {
  const [small, large] = left.size <= right.size ? [left, right] : [right, left];
  if (small.size < MIN_SHINGLES_TO_COMPARE) return 0;
  let shared = 0;
  for (const value of small) if (large.has(value)) shared += 1;
  return shared / small.size;
}

/**
 * Group URLs into independent sources.
 * Returns { independent, groups: [{ urls, site, reasons, unchecked? }], total }.
 * `textOf(url)` defaults to the session page store.
 */
export function independentSources(urls, { textOf = pageText } = {}) {
  const list = [...new Set((Array.isArray(urls) ? urls : []).map((url) => normalizeUrl(url)).filter(Boolean))].slice(0, MAX_URLS);
  const parent = list.map((_, index) => index);
  const reasons = list.map(() => new Set());
  const find = (index) => { while (parent[index] !== index) { parent[index] = parent[parent[index]]; index = parent[index]; } return index; };
  const join = (a, b, reason) => {
    const left = find(a);
    const right = find(b);
    if (left !== right) parent[right] = left;
    reasons[a].add(reason);
    reasons[b].add(reason);
  };
  const keys = list.map(sourceKey);
  const docs = list.map(canonicalDocument);
  const texts = list.map((url) => textOf(url) || '');
  const prints = texts.map((text) => (text ? shingles(text) : null));
  for (let a = 0; a < list.length; a += 1) {
    for (let b = a + 1; b < list.length; b += 1) {
      if (docs[a] === docs[b]) join(a, b, 'same page');
      else if (keys[a] && keys[a] === keys[b]) join(a, b, 'same site');
      else if (prints[a] && prints[b]) {
        const share = containment(prints[a], prints[b]);
        if (share >= COPY_CONTAINMENT) join(a, b, 'copied text (' + Math.round(share * 100) + '% of the shorter page appears in the other)');
      }
    }
  }
  const byRoot = new Map();
  list.forEach((url, index) => {
    const root = find(index);
    if (!byRoot.has(root)) byRoot.set(root, { urls: [], site: keys[root], reasons: new Set(), unchecked: false });
    const group = byRoot.get(root);
    group.urls.push(url);
    for (const reason of reasons[index]) group.reasons.add(reason);
    if (!texts[index]) group.unchecked = true;
  });
  const groups = [...byRoot.values()].map((group) => ({
    urls: group.urls,
    site: group.site,
    ...(group.reasons.size ? { reasons: [...group.reasons] } : {}),
    ...(group.unchecked ? { unchecked: true } : {})
  }));
  return { independent: groups.length, total: list.length, groups };
}

/** One line for prompts and tool results: "3 independent sources (5 URLs: ...)". */
export function describeIndependence(result) {
  if (!result.total) return 'no URL sources';
  const merged = result.groups.filter((group) => group.urls.length > 1);
  const head = result.independent + ' independent source' + (result.independent === 1 ? '' : 's');
  if (!merged.length) return head;
  return head + ' (' + result.total + ' URLs; ' + merged.map((group) => group.urls.length + ' from ' + (group.site || 'one origin') + (group.reasons && group.reasons.some((reason) => reason.startsWith('copied')) ? ' incl. copies' : '')).join(', ') + ')';
}
