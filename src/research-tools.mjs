// Research and fact-checking tools shared by the main agent and every
// subagent. They work on what this session has actually read (the page store
// in src/page-store.mjs and the evidence ledger), never on the model's memory
// of a page.
//
//   verify_quote         is this passage on that page, as I fetched it?
//   source_independence  how many independent sources do these URLs amount to?
import { normalizeUrl } from './evidence-ledger.mjs';
import { findQuote, pageText } from './page-store.mjs';
import { describeIndependence, independentSources } from './source-independence.mjs';

const fn = (name, description, properties, required = []) => ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required, additionalProperties: false } } });

export const RESEARCH_TOOL_DEFINITIONS = [
  fn('verify_quote', 'Check that passages you are about to quote or attribute really appear on the pages you fetched (fetch_url or browser earlier in this session). Matching ignores case, spacing, quote and dash styles; "..." splits a quote into pieces that must appear in order. Returns exact, near (a word or two differ: copy the page\'s wording) or missing, with the closest passage on the page. Use it before quoting a source in a report, and when fact-checking another agent\'s quote. Final reports are checked the same way, and a misquote gets the report rejected.',
    { checks: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', properties: {
      url: { type: 'string', description: 'The page the passage is attributed to' },
      quote: { type: 'string', description: 'The passage, as you would quote it' }
    }, required: ['url', 'quote'], additionalProperties: false } } }, ['checks']),
  fn('source_independence', 'Count how many independent sources a set of URLs really is before you call a claim corroborated. URLs on one site (subdomains included; one owner on github.com, medium.com and similar), the same page with tracking parameters or AMP, and pages whose fetched text copies another (syndicated wire stories, reprinted press releases, mirrors: half of the shorter page appears in the other) count once. Pages fetched in this session are compared by text; others by site only (unchecked). Use it when cross-checking: two outlets running the same wire story are one source, so look for one that reported independently.',
    { urls: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'string' }, description: 'The URLs that back one claim' } }, ['urls'])
];

export const RESEARCH_TOOL_NAMES = new Set(RESEARCH_TOOL_DEFINITIONS.map((tool) => tool.function.name));
export const RESEARCH_READ_ONLY_TOOL_NAMES = new Set(['verify_quote', 'source_independence']);

function verifyQuotes(args) {
  const checks = Array.isArray(args.checks) ? args.checks.slice(0, 20) : [];
  if (!checks.length) throw new Error('verify_quote needs checks: [{ url, quote }].');
  const results = checks.map((item) => {
    const url = normalizeUrl(item && item.url);
    const quote = String(item && item.quote || '').trim();
    if (!url) return { url: String(item && item.url || ''), status: 'invalid', message: 'Not an http(s) URL.' };
    if (!quote) return { url, status: 'invalid', message: 'Empty quote.' };
    const text = pageText(url);
    if (!text) return { url, status: 'not_fetched', message: 'This page was not fetched in this session (or was fetched before a restart). Fetch it with fetch_url, then check again.' };
    const found = findQuote(quote, text);
    return {
      url,
      status: found.status,
      ...(found.status === 'exact' ? {} : { similarity: found.similarity }),
      ...(found.context ? { closest: found.context } : {}),
      ...(found.status === 'near' ? { message: 'Almost: quote the page\'s exact words (see closest).' } : {}),
      ...(found.status === 'missing' ? { message: 'The page does not contain this passage. Do not attribute it to this source; quote what the page says (closest) or drop the quote.' } : {})
    };
  });
  const counts = {};
  for (const item of results) counts[item.status] = (counts[item.status] || 0) + 1;
  return { results, counts };
}

export function runResearchTool(session, name, args = {}) {
  if (name === 'verify_quote') return verifyQuotes(args || {});
  if (name === 'source_independence') {
    const urls = Array.isArray(args && args.urls) ? args.urls : [];
    if (!urls.length) throw new Error('source_independence needs urls: [...].');
    const result = independentSources(urls);
    return { summary: describeIndependence(result), ...result, ...(result.total < urls.length ? { ignored: urls.length - result.total + ' entries were not http(s) URLs or were duplicates' } : {}) };
  }
  throw new Error('Unknown research tool ' + name);
}
