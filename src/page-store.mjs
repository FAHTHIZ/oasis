// Page store and quote verification: did the cited page actually say that?
//
// The research contract (src/verification-contracts.mjs) already refuses a
// report that cites a URL the agent never fetched. That still lets an agent
// fetch a page and then attribute words to it that are not there, a failure
// language models make often and confidently ("misquotation" or "citation
// hallucination"). The runtime has the text the agent read, so it can check:
//
//   1. Every successful fetch_url / browser / research-pack fetch keeps the
//      text the agent was shown, in memory, keyed by URL (pageText).
//   2. A report or knowledge-board post that puts words in quotation marks
//      (or a > blockquote) next to a cited URL must find those words on that
//      page. Matching ignores case, whitespace, curly vs straight quotes,
//      dash styles and markdown emphasis; "..." or "…" in a quote splits it
//      into pieces that must appear in order.
//   3. A quote that is close but not exact (one word changed) is accepted
//      with a note; one that is not on the page is a `misquote` issue.
//
// Only pages fetched in this process are known. A URL fetched before a
// restart has no stored text, so its quotes are skipped rather than failed.
// Short quotes (fewer than five words: titles, terms, scare quotes) are not
// checked.

const MAX_PAGE_CHARS = 2_000_000;
const MAX_TOTAL_CHARS = 64_000_000;
const MIN_QUOTE_WORDS = 5;
const MAX_QUOTE_CHARS = 600;
const NEAR_MATCH = 0.85;

// url -> { text, at }. Map order is the LRU order.
const PAGES = new Map();
let totalChars = 0;

function evict() {
  for (const [url, page] of PAGES) {
    if (totalChars <= MAX_TOTAL_CHARS) break;
    PAGES.delete(url);
    totalChars -= page.text.length;
  }
}

/** Keeps what a fetch showed. Repeated fetches of one URL (pages, offsets) add up. */
export function rememberPage(url, text, { finalUrl } = {}) {
  const value = String(text || '');
  if (!url || !value.trim()) return;
  for (const key of new Set([url, finalUrl].filter(Boolean))) {
    const existing = PAGES.get(key);
    let next = existing ? existing.text : '';
    if (!next.includes(value)) next = (next ? next + '\n\n' : '') + value;
    if (next.length > MAX_PAGE_CHARS) next = next.slice(-MAX_PAGE_CHARS);
    if (existing) { PAGES.delete(key); totalChars -= existing.text.length; }
    PAGES.set(key, { text: next, at: Date.now() });
    totalChars += next.length;
  }
  evict();
}

/** The text fetched for a URL in this process, or null. */
export function pageText(url) {
  const page = url ? PAGES.get(url) : null;
  return page ? page.text : null;
}

/** For tests. */
export function clearPageStore() {
  PAGES.clear();
  totalChars = 0;
}

// ---------------------------------------------------------------------------
// Matching

/** Lowercased words with typography and markdown removed. */
export function quoteWords(text) {
  return String(text || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/[\u2018\u2019\u201a\u201b\u2032]/g, "'")
    .replace(/[\u201c\u201d\u201e\u201f\u2033\u00ab\u00bb]/g, '"')
    .replace(/[\u2010-\u2015\u2212-]+/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .split(/[^\p{L}\p{N}%$€£'.]+/u)
    .map((word) => word.replace(/^['.]+|['.]+$/g, ''))
    .filter(Boolean);
}

function indexOfSequence(haystack, needle, from = 0) {
  if (!needle.length) return from;
  const first = needle[0];
  for (let index = haystack.indexOf(first, from); index !== -1 && index <= haystack.length - needle.length; index = haystack.indexOf(first, index + 1)) {
    let ok = true;
    for (let offset = 1; offset < needle.length; offset += 1) if (haystack[index + offset] !== needle[offset]) { ok = false; break; }
    if (ok) return index;
  }
  return -1;
}

// Best word-overlap of `needle` against a window of the page, anchored on
// occurrences of the needle's rarest words, so a 2 MB page stays fast.
function bestWindow(words, needle) {
  if (!needle.length || !words.length) return { similarity: 0, at: -1 };
  const counts = new Map();
  for (const word of words) counts.set(word, (counts.get(word) || 0) + 1);
  const anchors = [...new Set(needle)].filter((word) => counts.has(word)).sort((a, b) => counts.get(a) - counts.get(b)).slice(0, 3);
  let best = { similarity: 0, at: -1 };
  const want = new Map();
  for (const word of needle) want.set(word, (want.get(word) || 0) + 1);
  for (const anchor of anchors) {
    const offsetInNeedle = needle.indexOf(anchor);
    for (let index = words.indexOf(anchor), seen = 0; index !== -1 && seen < 200; index = words.indexOf(anchor, index + 1), seen += 1) {
      const start = Math.max(0, index - offsetInNeedle - 2);
      const window = words.slice(start, start + needle.length + 4);
      const have = new Map();
      for (const word of window) have.set(word, (have.get(word) || 0) + 1);
      let common = 0;
      for (const [word, count] of want) common += Math.min(count, have.get(word) || 0);
      // In-order bonus: the longest run of needle words found in sequence.
      const similarity = common / needle.length;
      if (similarity > best.similarity) best = { similarity, at: start };
    }
  }
  return best;
}

function contextAround(rawText, words, at, length) {
  if (at < 0) return '';
  const snippet = words.slice(Math.max(0, at), at + length + 6).join(' ');
  return snippet.length > 300 ? snippet.slice(0, 300) + '…' : snippet;
}

/**
 * Looks for `quote` in `text`. Returns { status: 'exact' | 'near' | 'missing',
 * similarity, context } where context is the closest passage on the page.
 */
export function findQuote(quote, text) {
  const pieces = String(quote || '').split(/\.\.\.|…|\[\.\.\.\]|\[…\]/).map((piece) => quoteWords(piece)).filter((piece) => piece.length);
  const words = quoteWords(text);
  if (!pieces.length) return { status: 'missing', similarity: 0, context: '' };
  let from = 0;
  let exact = true;
  let firstAt = -1;
  for (const piece of pieces) {
    const at = indexOfSequence(words, piece, from);
    if (at === -1) { exact = false; break; }
    if (firstAt === -1) firstAt = at;
    from = at + piece.length;
  }
  if (exact) return { status: 'exact', similarity: 1, context: contextAround(text, words, firstAt, from - firstAt) };
  const needle = pieces.flat();
  const best = bestWindow(words, needle);
  return { status: best.similarity >= NEAR_MATCH ? 'near' : 'missing', similarity: Math.round(best.similarity * 100) / 100, context: contextAround(text, words, best.at, needle.length) };
}

// ---------------------------------------------------------------------------
// Quotes in reports

const QUOTE_SPANS = [
  /"([^"\n]{12,600})"/g,
  /\u201c([^\u201d\n]{12,600})\u201d/g,
  /\u00ab\s?([^\u00bb\n]{12,600}?)\s?\u00bb/g
];

/**
 * Quoted passages and the URLs cited in the same paragraph or list item:
 * [{ quote, urls }]. Code blocks and inline code are ignored. A > blockquote
 * counts as a quote when its paragraph (or the line after it) cites a URL.
 */
export function quotedClaims(text, citedUrls) {
  const prose = String(text || '').replace(/```[\s\S]*?```/g, '\n\n').replace(/`[^`\n]*`/g, ' ');
  const blocks = prose.split(/\n\s*\n|\n(?=\s*(?:[-*+]|\d+[.)])\s)/);
  const out = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    let urls = citedUrls(block);
    const quotes = [];
    for (const pattern of QUOTE_SPANS) for (const match of block.matchAll(pattern)) quotes.push(match[1]);
    const blockquote = block.split('\n').filter((line) => /^\s*>/.test(line)).map((line) => line.replace(/^\s*>\s?/, '')).join(' ').trim();
    if (blockquote) {
      // A blockquote is often followed by its attribution: "— [Source](url)".
      if (!urls.length && blocks[index + 1]) urls = citedUrls(blocks[index + 1].split('\n')[0]);
      const withoutUrls = blockquote.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/https?:\/\/\S+/g, ' ').replace(/[—–-]\s*$/, '').trim();
      if (withoutUrls) quotes.push(withoutUrls);
    }
    if (!urls.length) continue;
    for (const quote of quotes) {
      const value = quote.trim();
      if (value.length > MAX_QUOTE_CHARS) continue;
      if (quoteWords(value).length < MIN_QUOTE_WORDS) continue;
      out.push({ quote: value, urls });
    }
  }
  return out;
}

/**
 * Checks every quote in `text` against the stored page of each URL cited
 * with it. Returns { checked, misquotes: [{ quote, urls, closest, similarity }],
 * near: [...] }. URLs with no stored text are skipped.
 */
export function checkQuotes(text, citedUrls, { fetched = null } = {}) {
  const misquotes = [];
  const near = [];
  let checked = 0;
  for (const item of quotedClaims(text, citedUrls)) {
    const pages = item.urls.filter((url) => !fetched || fetched.has(url)).map((url) => ({ url, text: pageText(url) })).filter((page) => page.text);
    if (!pages.length) continue;
    checked += 1;
    let best = null;
    for (const page of pages) {
      const found = findQuote(item.quote, page.text);
      if (!best || found.similarity > best.similarity) best = { ...found, url: page.url };
      if (found.status === 'exact') break;
    }
    if (best.status === 'exact') continue;
    const entry = { quote: item.quote.slice(0, 200), urls: pages.map((page) => page.url), similarity: best.similarity, closest: best.context };
    if (best.status === 'near') near.push(entry); else misquotes.push(entry);
  }
  return { checked, misquotes, near };
}
